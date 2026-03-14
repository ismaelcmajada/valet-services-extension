import Clutter from "gi://Clutter"
import GObject from "gi://GObject"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import St from "gi://St"

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js"
import * as Main from "resource:///org/gnome/shell/ui/main.js"
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js"
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js"

// --- Colors for Pango markup on the panel label ---
const COLOR_GREEN = "#73d216"
const COLOR_YELLOW = "#f4a01b"
const COLOR_RED = "#cc0000"
const COLOR_GREY = "#888888"

// --- Pretty names for known services ---
const PRETTY_NAMES = {
  "php-fpm": "PHP-FPM",
  mysqld: "MySQL",
  mariadb: "MariaDB",
  nginx: "Nginx",
  dnsmasq: "dnsmasq",
}

function displayName(serviceName) {
  const base = serviceName.replace(/\.service$/, "")
  return PRETTY_NAMES[base] ?? base
}

function prettifyState(activeState) {
  switch (activeState) {
    case "active":
      return "activo"
    case "activating":
      return "activando"
    case "deactivating":
      return "deteniendo"
    case "failed":
      return "fallando"
    case "inactive":
      return "inactivo"
    default:
      return activeState || "desconocido"
  }
}

// --- ServiceWatcher: resolves path via GetUnit(), pure D-Bus signals ---

class ServiceWatcher {
  constructor(serviceName, onChanged) {
    this.serviceName = serviceName
    this._onChanged = onChanged
    this._activeState = "unknown"
    this._subId = 0
    this._proxy = null
    this._objectPath = null
    this._destroyed = false

    this._resolveAndConnect()
  }

  get activeState() {
    return this._activeState
  }

  destroy() {
    this._destroyed = true
    if (this._subId) {
      Gio.DBus.system.signal_unsubscribe(this._subId)
      this._subId = 0
    }
    this._proxy = null
  }

  _resolveAndConnect() {
    Gio.DBus.system.call(
      "org.freedesktop.systemd1",
      "/org/freedesktop/systemd1",
      "org.freedesktop.systemd1.Manager",
      "GetUnit",
      new GLib.Variant("(s)", [this.serviceName]),
      new GLib.VariantType("(o)"),
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (_conn, res) => {
        if (this._destroyed) return

        try {
          const result = _conn.call_finish(res)
          const [path] = result.deepUnpack()
          this._objectPath = path
          this._connectProxy(path)
        } catch (e) {
          logError(e, `GetUnit falló para ${this.serviceName}`)
          this._activeState = "not-found"
          this._onChanged()
        }
      },
    )
  }

  _connectProxy(path) {
    try {
      this._proxy = new Gio.DBusProxy({
        g_connection: Gio.DBus.system,
        g_name: "org.freedesktop.systemd1",
        g_object_path: path,
        g_interface_name: "org.freedesktop.systemd1.Unit",
      })

      this._proxy.init_async(GLib.PRIORITY_DEFAULT, null, (_obj, res) => {
        if (this._destroyed) return

        try {
          this._proxy.init_finish(res)
          this.refresh()
          this._subscribe(path)
        } catch (_e) {
          this._activeState = "not-found"
          this._onChanged()
        }
      })
    } catch (_e) {
      this._activeState = "not-found"
      this._onChanged()
    }
  }

  _subscribe(path) {
    this._subId = Gio.DBus.system.signal_subscribe(
      "org.freedesktop.systemd1",
      "org.freedesktop.DBus.Properties",
      "PropertiesChanged",
      path,
      null,
      Gio.DBusSignalFlags.NONE,
      () => this.refresh(),
    )
  }

  refresh() {
    if (!this._proxy) return

    try {
      const value = this._proxy.get_cached_property("ActiveState")
      if (value) this._activeState = value.unpack()
      else this._activeState = "unknown"
    } catch (_e) {
      this._activeState = "unknown"
    }

    this._onChanged()
  }
}

// --- Indicator ---

const ValetServicesIndicator = GObject.registerClass(
  class ValetServicesIndicator extends PanelMenu.Button {
    _init(settings) {
      super._init(0.0, "Valet Services", false)

      this._settings = settings
      this._watchers = new Map()
      this._actionProcesses = new Set()
      this._refreshQueued = false

      this._label = new St.Label({
        y_align: Clutter.ActorAlign.CENTER,
      })
      this._label.clutter_text.use_markup = true
      this.add_child(this._label)

      this._settingsChangedId = this._settings.connect("changed", () => {
        this._rebuildAll()
      })

      this._rebuildAll()
    }

    // --- Debounced refresh: coalesces rapid D-Bus signals ---

    _queueRefresh() {
      if (this._refreshQueued) return

      this._refreshQueued = true
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        this._refreshQueued = false
        this._refreshUI()
        return GLib.SOURCE_REMOVE
      })
    }

    // --- Full teardown & rebuild when settings change ---

    _rebuildAll() {
      this._destroyWatchers()
      this.menu.removeAll()

      this._valetServices = this._settings.get_strv("valet-services")
      this._dbCandidates = this._settings.get_strv("db-services")

      this._buildMenu()
      this._initWatchers()
      this._refreshUI()
    }

    _buildMenu() {
      this._summaryItem = new PopupMenu.PopupMenuItem("Comprobando…", {
        reactive: false,
        can_focus: false,
      })
      this.menu.addMenuItem(this._summaryItem)
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem())

      this._serviceItems = new Map()
      const allServices = [...this._valetServices, ...this._dbCandidates]

      for (const service of allServices) {
        const item = new PopupMenu.PopupMenuItem(`${displayName(service)}: …`, {
          reactive: false,
          can_focus: false,
        })
        this._serviceItems.set(service, item)
        this.menu.addMenuItem(item)
      }

      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem())

      this.menu.addAction("Refrescar ahora", () => this._refreshAll())
      this.menu.addAction("Iniciar stack Valet", () =>
        this._runValetStackAction("start"),
      )
      this.menu.addAction("Detener stack Valet", () =>
        this._runValetStackAction("stop"),
      )
      this.menu.addAction("Reiniciar stack Valet", () =>
        this._runValetStackAction("restart"),
      )
      this.menu.addAction("Reiniciar base de datos", () =>
        this._restartDatabase(),
      )
    }

    _initWatchers() {
      const allServices = [...this._valetServices, ...this._dbCandidates]
      for (const service of allServices) {
        const watcher = new ServiceWatcher(service, () => this._queueRefresh())
        this._watchers.set(service, watcher)
      }
    }

    // --- State helpers ---

    _getState(service) {
      return this._watchers.get(service)?.activeState ?? "unknown"
    }

    _resolveDbService() {
      for (const candidate of this._dbCandidates) {
        const state = this._getState(candidate)
        if (state !== "not-found") return candidate
      }
      return this._dbCandidates[0] ?? null
    }

    _valetStackState() {
      const states = this._valetServices
        .map((s) => this._getState(s))
        .filter((s) => s !== "not-found")

      if (states.length === 0) return "unknown"
      if (states.every((s) => s === "active")) return "active"
      if (states.some((s) => s === "active")) return "partial"
      if (states.some((s) => s === "failed")) return "failed"
      return "inactive"
    }

    _databaseState() {
      const dbService = this._resolveDbService()
      if (!dbService) return "unknown"
      return this._getState(dbService)
    }

    // --- UI refresh ---

    _refreshUI() {
      const valetState = this._valetStackState()
      const dbState = this._databaseState()
      const dbService = this._resolveDbService()

      // Panel label with Pango color markup
      const vColor =
        valetState === "active"
          ? COLOR_GREEN
          : valetState === "partial"
            ? COLOR_YELLOW
            : COLOR_RED
      const dColor =
        dbState === "active"
          ? COLOR_GREEN
          : dbState === "activating" || dbState === "deactivating"
            ? COLOR_YELLOW
            : COLOR_RED

      const vDot =
        valetState === "active" ? "●" : valetState === "partial" ? "◐" : "○"
      const dDot = dbState === "active" ? "●" : "○"

      this._label.clutter_text.set_markup(
        `<span color="${vColor}">V${vDot}</span> <span color="${dColor}">DB${dDot}</span>`,
      )

      // Summary line — distinguish failed vs inactive for DB
      const valetWord =
        valetState === "active"
          ? "activo"
          : valetState === "partial"
            ? "parcial"
            : valetState === "failed"
              ? "fallando"
              : "inactivo"
      const dbWord = prettifyState(dbState)
      const dbName = dbService ? displayName(dbService) : "DB"
      this._summaryItem.label.set_text(
        `Valet: ${valetWord} · ${dbName}: ${dbWord}`,
      )

      // Per-service lines
      const allServices = [...this._valetServices, ...this._dbCandidates]
      for (const service of allServices) {
        const state = this._getState(service)
        const item = this._serviceItems.get(service)
        if (!item) continue

        if (state === "not-found")
          item.label.set_text(`${displayName(service)}: no instalado`)
        else
          item.label.set_text(
            `${displayName(service)}: ${prettifyState(state)}`,
          )
      }
    }

    _refreshAll() {
      for (const watcher of this._watchers.values()) watcher.refresh()
    }

    // --- Actions: single pkexec for multiple services ---

    _spawnPkexecSystemctlMulti(action, services) {
      const existing = services.filter((s) => this._getState(s) !== "not-found")
      if (existing.length === 0) return

      try {
        const proc = Gio.Subprocess.new(
          ["pkexec", "systemctl", action, ...existing],
          Gio.SubprocessFlags.NONE,
        )
        this._actionProcesses.add(proc)
        proc.wait_check_async(null, (_obj, _res) => {
          this._actionProcesses.delete(proc)
          this._refreshAll()
        })
      } catch (_e) {
        this._refreshAll()
      }
    }

    _runValetStackAction(action) {
      this._spawnPkexecSystemctlMulti(action, this._valetServices)
    }

    _restartDatabase() {
      const dbService = this._resolveDbService()
      if (dbService) this._spawnPkexecSystemctlMulti("restart", [dbService])
    }

    // --- Cleanup ---

    _destroyWatchers() {
      for (const watcher of this._watchers.values()) watcher.destroy()
      this._watchers.clear()
      this._actionProcesses.clear()
    }

    destroy() {
      if (this._settingsChangedId) {
        this._settings.disconnect(this._settingsChangedId)
        this._settingsChangedId = 0
      }
      this._destroyWatchers()
      super.destroy()
    }
  },
)

// --- Extension entry point ---

export default class ValetServicesExtension extends Extension {
  enable() {
    this._settings = this.getSettings()
    this._indicator = new ValetServicesIndicator(this._settings)
    Main.panel.addToStatusArea(this.uuid, this._indicator, 1, "right")
  }

  disable() {
    if (this._indicator) {
      this._indicator.destroy()
      this._indicator = null
    }
    this._settings = null
  }
}
