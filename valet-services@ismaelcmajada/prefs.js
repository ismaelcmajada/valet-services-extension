import Adw from "gi://Adw"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk"

import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js"

export default class ValetServicesPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings()

    const page = new Adw.PreferencesPage({
      title: "Valet Services",
      icon_name: "preferences-system-symbolic",
    })
    window.add(page)

    const createTextArea = (initialText, height = 100) => {
      const view = new Gtk.TextView({
        wrap_mode: Gtk.WrapMode.WORD_CHAR,
        top_margin: 8,
        bottom_margin: 8,
        left_margin: 8,
        right_margin: 8,
        monospace: true,
      })

      view.get_buffer().set_text(initialText, -1)

      const frame = new Gtk.Frame({
        child: view,
        margin_start: 12,
        margin_end: 12,
        margin_top: 4,
        margin_bottom: 4,
      })

      frame.set_size_request(-1, height)

      return { view, frame }
    }

    const parseBuf = (buf) => {
      const [start, end] = [buf.get_start_iter(), buf.get_end_iter()]
      return buf
        .get_text(start, end, false)
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    }

    // --- Valet stack group ---
    const valetGroup = new Adw.PreferencesGroup({
      title: "Servicios del stack Valet",
      description:
        "Unidades de systemd que forman el stack web. Una por línea.",
    })
    page.add(valetGroup)

    const { view: valetEntry, frame: valetFrame } = createTextArea(
      settings.get_strv("valet-services").join("\n"),
      120,
    )
    valetGroup.add(valetFrame)

    // --- Database group ---
    const dbGroup = new Adw.PreferencesGroup({
      title: "Candidatos de base de datos",
      description: "Se usará el primero que esté instalado. Una por línea.",
    })
    page.add(dbGroup)

    const { view: dbEntry, frame: dbFrame } = createTextArea(
      settings.get_strv("db-services").join("\n"),
      80,
    )
    dbGroup.add(dbFrame)

    // --- Pre-start group ---
    const preStartGroup = new Adw.PreferencesGroup({
      title: "Pre-arranque",
      description: "Se ejecuta antes de arrancar el servicio. Uno por línea.",
    })
    page.add(preStartGroup)

    const { view: preStartEntry, frame: preStartFrame } = createTextArea(
      settings.get_strv("pre-start-commands").join("\n"),
      100,
    )
    preStartGroup.add(preStartFrame)

    // --- Post-start group ---
    const postStartGroup = new Adw.PreferencesGroup({
      title: "Post-arranque",
      description: "Se ejecuta después de arrancar el servicio. Uno por línea.",
    })
    page.add(postStartGroup)

    const { view: postStartEntry, frame: postStartFrame } = createTextArea(
      settings.get_strv("post-start-commands").join("\n"),
      100,
    )
    postStartGroup.add(postStartFrame)

    // --- Pre-stop group ---
    const preStopGroup = new Adw.PreferencesGroup({
      title: "Pre-parada",
      description: "Se ejecuta antes de detener el servicio. Uno por línea.",
    })
    page.add(preStopGroup)

    const { view: preStopEntry, frame: preStopFrame } = createTextArea(
      settings.get_strv("pre-stop-commands").join("\n"),
      100,
    )
    preStopGroup.add(preStopFrame)

    // --- Post-stop group ---
    const postStopGroup = new Adw.PreferencesGroup({
      title: "Post-parada",
      description: "Se ejecuta después de detener el servicio. Uno por línea.",
    })
    page.add(postStopGroup)

    const { view: postStopEntry, frame: postStopFrame } = createTextArea(
      settings.get_strv("post-stop-commands").join("\n"),
      100,
    )
    postStopGroup.add(postStopFrame)

    // --- Hook service selector (dynamic) ---
    const hookSelectorGroup = new Adw.PreferencesGroup({
      title: "Servicios con hooks",
      description:
        "Selecciona a qué servicios se aplican los overrides de systemd.",
    })
    page.add(hookSelectorGroup)

    let checkRows = new Map()
    let hookRows = []

    const rebuildHookSelector = () => {
      // Capture current UI selection before destroying rows
      const previousSelection = new Set()
      for (const [service, check] of checkRows) {
        if (check.active) previousSelection.add(service)
      }

      for (const row of hookRows) hookSelectorGroup.remove(row)
      hookRows = []
      checkRows.clear()

      // Build service list from current buffer contents
      const valetList = parseBuf(valetEntry.get_buffer())
      const dbList = parseBuf(dbEntry.get_buffer())
      const allServices = [...new Set([...valetList, ...dbList])].filter(
        (s) => s.length > 0,
      )

      const savedHookServices = new Set(settings.get_strv("hook-services"))

      for (const service of allServices) {
        const active =
          previousSelection.has(service) || savedHookServices.has(service)

        const check = new Gtk.CheckButton({ active })
        const row = new Adw.ActionRow({ title: service })
        row.add_prefix(check)
        row.activatable_widget = check
        hookSelectorGroup.add(row)
        hookRows.push(row)
        checkRows.set(service, check)
      }
    }

    rebuildHookSelector()

    // Regenerate checkboxes when service buffers change
    valetEntry.get_buffer().connect("changed", () => rebuildHookSelector())
    dbEntry.get_buffer().connect("changed", () => rebuildHookSelector())

    // --- Apply overrides button ---
    const applyGroup = new Adw.PreferencesGroup()
    page.add(applyGroup)

    const statusLabel = new Gtk.Label({
      label: "",
      wrap: true,
      xalign: 0,
      margin_start: 12,
      margin_end: 12,
    })

    const applyButton = new Gtk.Button({
      label: "Aplicar overrides",
      css_classes: ["suggested-action"],
      margin_start: 12,
      margin_end: 12,
      margin_top: 4,
      margin_bottom: 4,
    })

    applyButton.connect("clicked", () => {
      saveAll()

      statusLabel.set_text("Aplicando overrides…")
      applyButton.sensitive = false

      const scriptPath = GLib.build_filenamev([this.path, "apply-hooks.sh"])

      try {
        const proc = Gio.Subprocess.new(
          ["/usr/bin/bash", scriptPath],
          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        )

        proc.communicate_utf8_async(null, null, (obj, res) => {
          try {
            const [, stdout, stderr] = obj.communicate_utf8_finish(res)
            const out = stdout.trim()
            const err = stderr.trim()

            if (obj.get_successful()) {
              const parts = [out || "Overrides aplicados correctamente."]
              if (err) parts.push(`Avisos: ${err}`)
              statusLabel.set_text(parts.join("\n"))
            } else {
              statusLabel.set_text(
                `Error: ${err || out || "fallo desconocido"}`,
              )
            }
          } catch (e) {
            statusLabel.set_text(`Error: ${e.message}`)
          }

          applyButton.sensitive = true
        })
      } catch (e) {
        statusLabel.set_text(`Error lanzando script: ${e.message}`)
        applyButton.sensitive = true
      }
    })

    applyGroup.add(applyButton)
    applyGroup.add(statusLabel)

    // --- Save helper ---
    const saveAll = () => {
      settings.set_strv("valet-services", parseBuf(valetEntry.get_buffer()))
      settings.set_strv("db-services", parseBuf(dbEntry.get_buffer()))

      const selectedHooks = []
      for (const [service, check] of checkRows) {
        if (check.active) selectedHooks.push(service)
      }
      settings.set_strv("hook-services", selectedHooks)

      settings.set_strv(
        "pre-start-commands",
        parseBuf(preStartEntry.get_buffer()),
      )
      settings.set_strv(
        "post-start-commands",
        parseBuf(postStartEntry.get_buffer()),
      )
      settings.set_strv(
        "pre-stop-commands",
        parseBuf(preStopEntry.get_buffer()),
      )
      settings.set_strv(
        "post-stop-commands",
        parseBuf(postStopEntry.get_buffer()),
      )
    }

    // --- Save on close ---
    window.connect("close-request", () => {
      saveAll()
    })
  }
}
