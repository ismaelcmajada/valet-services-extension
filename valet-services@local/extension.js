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

// --- Pretty names for known services ---
const PRETTY_NAMES = {
  "php-fpm": "PHP-FPM",
  mysqld: "MySQL",
  mariadb: "MariaDB",
  nginx: "Nginx",
  dnsmasq: "dnsmasq",
}

function normalizeUnitName(name) {
  const trimmed = name.trim()
  if (!trimmed) return ""
  return trimmed.endsWith(".service") ? trimmed : `${trimmed}.service`
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

// --- ServiceWatcher: resolves path via LoadUnit(), pure D-Bus signals ---

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
      "LoadUnit",
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
        } catch (_e) {
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
      const loadValue = this._proxy.get_cached_property("LoadState")
      const activeValue = this._proxy.get_cached_property("ActiveState")

      const loadState = loadValue ? loadValue.unpack() : "unknown"

      if (loadState === "not-found") {
        this._activeState = "not-found"
      } else if (activeValue) {
        this._activeState = activeValue.unpack()
      } else {
        this._activeState = "unknown"
      }
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
      this._busy = false
      this._destroyed = false
      this._refreshSourceId = 0

      this._label = new St.Label({
        y_align: Clutter.ActorAlign.CENTER,
      })
      this._label.clutter_text.use_markup = true
      this.add_child(this._label)

      this._settingsChangedId = this._settings.connect("changed", () => {
        this._rebuildAll()
      })

      this._menuOpenChangedId = this.menu.connect(
        "open-state-changed",
        (_menu, open) => {
          if (!open) this._safeRebuildActions()
        },
      )

      this._rebuildAll()
    }

    // --- Debounced refresh: coalesces rapid D-Bus signals ---

    _queueRefresh() {
      if (this._destroyed || this._refreshSourceId) return

      this._refreshSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        this._refreshSourceId = 0

        if (this._destroyed) return GLib.SOURCE_REMOVE

        this._refreshUI()
        return GLib.SOURCE_REMOVE
      })
    }

    // --- Full teardown & rebuild when settings change ---

    _rebuildAll() {
      this._destroyWatchers()
      this.menu.removeAll()

      this._valetServices = this._settings
        .get_strv("valet-services")
        .map(normalizeUnitName)
        .filter(Boolean)
      this._dbCandidates = this._settings
        .get_strv("db-services")
        .map(normalizeUnitName)
        .filter(Boolean)
      this._allWatched = [
        ...new Set([
          ...this._valetServices,
          ...this._dbCandidates,
          "dnsmasq.service",
        ]),
      ]

      this._buildMenu()
      this._initWatchers()
      this._refreshUI()
    }

    _buildMenu() {
      // Summary
      this._summaryItem = new PopupMenu.PopupMenuItem("Comprobando…", {
        reactive: false,
        can_focus: false,
      })
      this.menu.addMenuItem(this._summaryItem)
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem())

      // Per-service status lines
      this._serviceItems = new Map()
      for (const service of this._allWatched) {
        const item = new PopupMenu.PopupMenuItem(`${displayName(service)}: …`, {
          reactive: false,
          can_focus: false,
        })
        this._serviceItems.set(service, item)
        this.menu.addMenuItem(item)
      }

      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem())

      // Dynamic actions section — rebuilt on every refresh
      this._actionsSection = new PopupMenu.PopupMenuSection()
      this.menu.addMenuItem(this._actionsSection)
    }

    _rebuildActions() {
      this._actionsSection.removeAll()

      if (this._busy) {
        this._actionsSection.addAction("⏳ Ejecutando…", () => {})
        return
      }

      this._actionsSection.addAction("Refrescar ahora", () =>
        this._refreshAll(),
      )

      // Stack actions based on current state
      const valetState = this._valetStackState()

      if (["inactive", "failed", "unknown"].includes(valetState))
        this._actionsSection.addAction("Iniciar stack Valet", () =>
          this._startValetStack(),
        )

      if (
        ["active", "partial", "activating", "deactivating"].includes(valetState)
      )
        this._actionsSection.addAction("Detener stack Valet", () =>
          this._stopValetStack(),
        )

      if (["active", "partial"].includes(valetState))
        this._actionsSection.addAction("Reiniciar stack Valet", () =>
          this._restartValetStack(),
        )

      // DB actions
      this._actionsSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem())
      const dbState = this._databaseState()

      if (["inactive", "failed", "unknown"].includes(dbState))
        this._actionsSection.addAction("Iniciar BD", () =>
          this._startDatabase(),
        )

      if (["active", "activating", "deactivating"].includes(dbState))
        this._actionsSection.addAction("Parar BD", () => this._stopDatabase())

      if (dbState === "active")
        this._actionsSection.addAction("Reiniciar BD", () =>
          this._restartDatabase(),
        )
    }

    _initWatchers() {
      for (const service of this._allWatched) {
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
      return null
    }

    _resolveDnsService() {
      return this._getState("dnsmasq.service") !== "not-found"
        ? "dnsmasq.service"
        : null
    }

    _valetStackState() {
      const states = this._valetServices
        .map((s) => this._getState(s))
        .filter((s) => s !== "not-found")

      if (states.length === 0) return "unknown"
      if (states.every((s) => s === "active")) return "active"
      if (states.some((s) => s === "failed")) return "failed"
      if (states.some((s) => s === "active")) return "partial"
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

      if (this._label?.clutter_text) {
        this._label.clutter_text.set_markup(
          `<span color="${vColor}">V${vDot}</span> <span color="${dColor}">DB${dDot}</span>`,
        )
      }

      // Summary line
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
      if (this._summaryItem?.label) {
        this._summaryItem.label.set_text(
          `Valet: ${valetWord} · ${dbName}: ${dbWord}`,
        )
      }

      // Per-service lines
      for (const service of this._allWatched) {
        const state = this._getState(service)
        const item = this._serviceItems.get(service)
        if (!item?.label) continue

        if (state === "not-found")
          item.label.set_text(`${displayName(service)}: no instalado`)
        else
          item.label.set_text(
            `${displayName(service)}: ${prettifyState(state)}`,
          )
      }

      // Rebuild action buttons to match current state
      if (!this.menu.isOpen) this._safeRebuildActions()
    }

    _safeRebuildActions() {
      if (this._destroyed || !this._actionsSection) return

      try {
        this._rebuildActions()
      } catch (e) {
        logError(e, "Error reconstruyendo acciones del menú")
      }
    }

    _refreshAll() {
      for (const watcher of this._watchers.values()) watcher.refresh()
    }

    // --- Command helpers ---

    _systemctlCmd(action, ...services) {
      return ["/usr/bin/pkexec", "/usr/bin/systemctl", action, ...services]
    }

    _existingServices(services) {
      return services.filter(
        (service) => this._getState(service) !== "not-found",
      )
    }

    _runSubprocess(argv) {
      return new Promise((resolve, reject) => {
        try {
          const proc = Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
          )

          this._actionProcesses.add(proc)

          proc.communicate_utf8_async(null, null, (obj, res) => {
            this._actionProcesses.delete(proc)

            try {
              const [, stdout, stderr] = obj.communicate_utf8_finish(res)
              const status = obj.get_exit_status()

              if (obj.get_successful()) {
                resolve({ stdout, stderr, status })
                return
              }

              reject(
                new Error(
                  `Command failed (${status}): ${argv.join(" ")}\n` +
                    `stdout:\n${stdout || "(vacío)"}\n` +
                    `stderr:\n${stderr || "(vacío)"}`,
                ),
              )
            } catch (e) {
              reject(e)
            }
          })
        } catch (e) {
          reject(e)
        }
      })
    }

    async _runSequence(steps) {
      this._busy = true

      try {
        for (const step of steps) await this._runSubprocess(step)
      } finally {
        this._busy = false
        this._refreshAll()
      }
    }

    // --- Stack orchestration ---

    async _startValetStack() {
      if (this._busy) return
      this.menu.close()

      const dbService = this._resolveDbService()
      const dnsService = this._resolveDnsService()
      const steps = []

      const toStart = []

      if (dbService) toStart.push(dbService)

      if (dnsService) toStart.push(dnsService)

      toStart.push(...this._existingServices(this._valetServices))

      if (toStart.length) steps.push(this._systemctlCmd("start", ...toStart))

      try {
        await this._runSequence(steps)
      } catch (e) {
        logError(e, "Error arrancando el stack Valet")
      }
    }

    async _stopValetStack() {
      if (this._busy) return
      this.menu.close()

      const dbService = this._resolveDbService()
      const steps = []

      const toStop = []

      toStop.push(...this._existingServices(this._valetServices))

      if (dbService) toStop.push(dbService)

      if (toStop.length) steps.push(this._systemctlCmd("stop", ...toStop))

      try {
        await this._runSequence(steps)
      } catch (e) {
        logError(e, "Error deteniendo el stack Valet")
      }
    }

    async _restartValetStack() {
      if (this._busy) return
      this.menu.close()

      const dbService = this._resolveDbService()
      const dnsService = this._resolveDnsService()
      const steps = []

      const toRestart = []

      if (dbService) toRestart.push(dbService)
      if (dnsService) toRestart.push(dnsService)
      toRestart.push(...this._existingServices(this._valetServices))

      if (toRestart.length)
        steps.push(this._systemctlCmd("restart", ...toRestart))

      try {
        await this._runSequence(steps)
      } catch (e) {
        logError(e, "Error reiniciando el stack Valet")
      }
    }
    // --- Database actions ---

    async _startDatabase() {
      if (this._busy) return
      this.menu.close()

      const dbService = this._resolveDbService()
      if (!dbService) return

      try {
        await this._runSequence([this._systemctlCmd("start", dbService)])
      } catch (e) {
        logError(e, "Error arrancando la base de datos")
      }
    }

    async _stopDatabase() {
      if (this._busy) return
      this.menu.close()

      const dbService = this._resolveDbService()
      if (!dbService) return

      try {
        await this._runSequence([this._systemctlCmd("stop", dbService)])
      } catch (e) {
        logError(e, "Error deteniendo la base de datos")
      }
    }

    async _restartDatabase() {
      if (this._busy) return
      this.menu.close()

      const dbService = this._resolveDbService()
      if (!dbService) return

      try {
        await this._runSequence([this._systemctlCmd("restart", dbService)])
      } catch (e) {
        logError(e, "Error reiniciando la base de datos")
      }
    }

    // --- Cleanup ---

    _destroyWatchers() {
      for (const watcher of this._watchers.values()) watcher.destroy()
      this._watchers.clear()
      this._actionProcesses.clear()
    }

    destroy() {
      this._destroyed = true

      if (this._menuOpenChangedId) {
        this.menu.disconnect(this._menuOpenChangedId)
        this._menuOpenChangedId = 0
      }

      if (this._refreshSourceId) {
        GLib.Source.remove(this._refreshSourceId)
        this._refreshSourceId = 0
      }

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
