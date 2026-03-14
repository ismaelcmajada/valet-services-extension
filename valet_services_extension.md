# Valet Services GNOME Extension

Extensión minimalista para GNOME Shell (45+) pensada para consumir lo mínimo posible.

## Qué hace

- Muestra un indicador pequeño en la barra superior.
- Vigila estos servicios de systemd:
  - `nginx.service`
  - `dnsmasq.service`
  - `php-fpm.service`
  - `mariadb.service`
  - `mysqld.service`
- Calcula un estado resumido:
  - `V● DB●` = todo bien
  - `V● DB○` = Valet ok, DB caída
  - `V○ DB●` = DB ok, stack Valet caída/parcial
- Evita polling agresivo:
  - escucha cambios por D-Bus cuando es posible
  - hace un refresco de respaldo cada 30 s
- Permite lanzar acciones rápidas (`systemctl start|stop|restart`) mediante `pkexec`.

## Estructura

```text
~/.local/share/gnome-shell/extensions/valet-services@local/
├── extension.js
└── metadata.json
```

## metadata.json

```json
{
  "uuid": "valet-services@local",
  "name": "Valet Services",
  "description": "Minimal service monitor for Valet Linux and MySQL/MariaDB",
  "shell-version": ["45", "46", "47", "48"],
  "version": 1,
  "url": "https://example.invalid/valet-services"
}
```

## extension.js

```javascript
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const SERVICES = [
    'nginx.service',
    'dnsmasq.service',
    'php-fpm.service',
    'mariadb.service',
    'mysqld.service',
];

const DISPLAY_NAMES = {
    'nginx.service': 'Nginx',
    'dnsmasq.service': 'dnsmasq',
    'php-fpm.service': 'PHP-FPM',
    'mariadb.service': 'MariaDB',
    'mysqld.service': 'MySQL',
};

function serviceToPath(serviceName) {
    const escaped = serviceName
        .replace(/_/g, '_5f')
        .replace(/\./g, '_2e')
        .replace(/-/g, '_2d');
    return `/org/freedesktop/systemd1/unit/${escaped}`;
}

function stateSymbol(activeState) {
    return activeState === 'active' ? '●' : '○';
}

function prettifyState(activeState) {
    switch (activeState) {
    case 'active':
        return 'activo';
    case 'activating':
        return 'activando';
    case 'deactivating':
        return 'deteniendo';
    case 'failed':
        return 'fallando';
    case 'inactive':
        return 'inactivo';
    default:
        return activeState || 'desconocido';
    }
}

class ServiceWatcher {
    constructor(serviceName, onChanged) {
        this.serviceName = serviceName;
        this._onChanged = onChanged;
        this._activeState = 'unknown';
        this._subId = 0;
        this._proxy = null;
        this._fallbackTimerId = 0;

        this._connect();
        this._fallbackTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            30,
            () => {
                this.refresh();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    get activeState() {
        return this._activeState;
    }

    destroy() {
        if (this._subId) {
            Gio.DBus.system.signal_unsubscribe(this._subId);
            this._subId = 0;
        }

        if (this._fallbackTimerId) {
            GLib.Source.remove(this._fallbackTimerId);
            this._fallbackTimerId = 0;
        }

        this._proxy = null;
    }

    _connect() {
        const path = serviceToPath(this.serviceName);

        try {
            this._proxy = new Gio.DBusProxy({
                g_connection: Gio.DBus.system,
                g_name: 'org.freedesktop.systemd1',
                g_object_path: path,
                g_interface_name: 'org.freedesktop.systemd1.Unit',
            });

            this._proxy.init_async(GLib.PRIORITY_DEFAULT, null, (_obj, res) => {
                try {
                    this._proxy.init_finish(res);
                    this.refresh();
                    this._subscribe();
                } catch (_e) {
                    this._activeState = 'not-found';
                    this._onChanged();
                }
            });
        } catch (_e) {
            this._activeState = 'not-found';
            this._onChanged();
        }
    }

    _subscribe() {
        const path = serviceToPath(this.serviceName);

        this._subId = Gio.DBus.system.signal_subscribe(
            'org.freedesktop.systemd1',
            'org.freedesktop.DBus.Properties',
            'PropertiesChanged',
            path,
            null,
            Gio.DBusSignalFlags.NONE,
            () => {
                this.refresh();
            }
        );
    }

    refresh() {
        if (!this._proxy)
            return;

        try {
            const value = this._proxy.get_cached_property('ActiveState');
            if (value)
                this._activeState = value.unpack();
            else
                this._activeState = 'unknown';
        } catch (_e) {
            this._activeState = 'unknown';
        }

        this._onChanged();
    }
}

class ValetServicesIndicator extends PanelMenu.Button {
    constructor() {
        super(0.0, 'Valet Services', false);

        this._watchers = new Map();
        this._actionProcesses = new Set();

        this._label = new St.Label({
            text: 'V○ DB○',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.add_child(this._label);

        this._buildMenu();
        this._initWatchers();
        this._refreshUI();
    }

    _buildMenu() {
        this._summaryItem = new PopupMenu.PopupMenuItem('Comprobando servicios…', {
            reactive: false,
            can_focus: false,
        });
        this.menu.addMenuItem(this._summaryItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._serviceItems = new Map();
        for (const service of SERVICES) {
            const item = new PopupMenu.PopupMenuItem(`${DISPLAY_NAMES[service]}: …`, {
                reactive: false,
                can_focus: false,
            });
            this._serviceItems.set(service, item);
            this.menu.addMenuItem(item);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.menu.addAction('Refrescar ahora', () => this._refreshAll());
        this.menu.addAction('Iniciar stack Valet', () => this._runValetStackAction('start'));
        this.menu.addAction('Detener stack Valet', () => this._runValetStackAction('stop'));
        this.menu.addAction('Reiniciar stack Valet', () => this._runValetStackAction('restart'));
        this.menu.addAction('Reiniciar base de datos', () => this._restartDatabase());
    }

    _initWatchers() {
        for (const service of SERVICES) {
            const watcher = new ServiceWatcher(service, () => this._refreshUI());
            this._watchers.set(service, watcher);
        }
    }

    _getState(service) {
        return this._watchers.get(service)?.activeState ?? 'unknown';
    }

    _dbServiceName() {
        const maria = this._getState('mariadb.service');
        const mysql = this._getState('mysqld.service');

        if (maria !== 'not-found')
            return 'mariadb.service';
        if (mysql !== 'not-found')
            return 'mysqld.service';
        return 'mariadb.service';
    }

    _valetStackState() {
        const nginx = this._getState('nginx.service');
        const dnsmasq = this._getState('dnsmasq.service');
        const phpfpm = this._getState('php-fpm.service');

        const states = [nginx, dnsmasq, phpfpm].filter(s => s !== 'not-found');
        if (states.length === 0)
            return 'unknown';
        if (states.every(s => s === 'active'))
            return 'active';
        if (states.some(s => s === 'active'))
            return 'partial';
        return 'inactive';
    }

    _databaseState() {
        const dbService = this._dbServiceName();
        const state = this._getState(dbService);
        return state === 'active' ? 'active' : 'inactive';
    }

    _refreshUI() {
        const valetState = this._valetStackState();
        const dbState = this._databaseState();

        const valetSymbol = valetState === 'active' ? '●' : '○';
        const dbSymbol = dbState === 'active' ? '●' : '○';

        this._label.set_text(`V${valetSymbol} DB${dbSymbol}`);

        let summary = 'Valet: ';
        summary += valetState === 'active' ? 'activo' : valetState === 'partial' ? 'parcial' : valetState === 'inactive' ? 'inactivo' : 'desconocido';
        summary += ` · DB: ${dbState === 'active' ? 'activa' : 'inactiva'}`;
        this._summaryItem.label.set_text(summary);

        for (const service of SERVICES) {
            const state = this._getState(service);
            const item = this._serviceItems.get(service);
            if (!item)
                continue;

            if (state === 'not-found')
                item.label.set_text(`${DISPLAY_NAMES[service]}: no instalado`);
            else
                item.label.set_text(`${DISPLAY_NAMES[service]}: ${prettifyState(state)}`);
        }
    }

    _refreshAll() {
        for (const watcher of this._watchers.values())
            watcher.refresh();
    }

    _spawnPkexecSystemctl(action, service) {
        try {
            const proc = Gio.Subprocess.new(
                ['pkexec', 'systemctl', action, service],
                Gio.SubprocessFlags.NONE
            );
            this._actionProcesses.add(proc);
            proc.wait_check_async(null, (_obj, _res) => {
                this._actionProcesses.delete(proc);
                this._refreshAll();
            });
        } catch (_e) {
            this._refreshAll();
        }
    }

    _runValetStackAction(action) {
        for (const service of ['nginx.service', 'dnsmasq.service', 'php-fpm.service']) {
            if (this._getState(service) !== 'not-found')
                this._spawnPkexecSystemctl(action, service);
        }
    }

    _restartDatabase() {
        const dbService = this._dbServiceName();
        this._spawnPkexecSystemctl('restart', dbService);
    }

    destroy() {
        for (const watcher of this._watchers.values())
            watcher.destroy();
        this._watchers.clear();
        this._actionProcesses.clear();
        super.destroy();
    }
}

export default class ValetServicesExtension extends Extension {
    enable() {
        this._indicator = new ValetServicesIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'right');
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
```

## Nota importante

En la línea del `St.Label` el código usa `Clutter.ActorAlign.CENTER`, así que si tu GNOME lo requiere, añade este import arriba del todo en `extension.js`:

```javascript
import Clutter from 'gi://Clutter';
```

Si prefieres evitar esa dependencia, puedes quitar `y_align` del `St.Label` y dejar solo:

```javascript
this._label = new St.Label({
    text: 'V○ DB○',
});
```

## Instalación

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/valet-services@local
```

Guarda ahí los dos archivos.

Luego reinicia GNOME Shell o cierra sesión.

Para activar la extensión:

```bash
gnome-extensions enable valet-services@local
```

Para desactivarla:

```bash
gnome-extensions disable valet-services@local
```

## Ajuste opcional para menos consumo todavía

Si quieres lo más mínimo de lo mínimo, puedes quitar el temporizador de respaldo de 30 s en `ServiceWatcher` eliminando este bloque:

```javascript
this._fallbackTimerId = GLib.timeout_add_seconds(
    GLib.PRIORITY_DEFAULT,
    30,
    () => {
        this.refresh();
        return GLib.SOURCE_CONTINUE;
    }
);
```

Con eso dependes solo de señales D-Bus.

## Limitación realista

La monitorización es muy eficiente, pero las acciones `start/stop/restart` abrirán autenticación con `pkexec` salvo que luego añadas una regla de polkit.

