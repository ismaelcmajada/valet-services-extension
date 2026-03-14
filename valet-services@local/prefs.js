import Adw from "gi://Adw"
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

    // --- Valet stack group ---
    const valetGroup = new Adw.PreferencesGroup({
      title: "Servicios del stack Valet",
      description:
        "Unidades de systemd que forman el stack web. Una por línea.",
    })
    page.add(valetGroup)

    const valetEntry = new Gtk.TextView({
      wrap_mode: Gtk.WrapMode.WORD_CHAR,
      top_margin: 8,
      bottom_margin: 8,
      left_margin: 8,
      right_margin: 8,
      monospace: true,
    })
    valetEntry
      .get_buffer()
      .set_text(settings.get_strv("valet-services").join("\n"), -1)

    const valetFrame = new Gtk.Frame({
      child: valetEntry,
      margin_start: 12,
      margin_end: 12,
      margin_top: 4,
      margin_bottom: 4,
    })
    valetFrame.set_size_request(-1, 120)
    valetGroup.add(valetFrame)

    // --- Database group ---
    const dbGroup = new Adw.PreferencesGroup({
      title: "Candidatos de base de datos",
      description: "Se usará el primero que esté instalado. Una por línea.",
    })
    page.add(dbGroup)

    const dbEntry = new Gtk.TextView({
      wrap_mode: Gtk.WrapMode.WORD_CHAR,
      top_margin: 8,
      bottom_margin: 8,
      left_margin: 8,
      right_margin: 8,
      monospace: true,
    })
    dbEntry
      .get_buffer()
      .set_text(settings.get_strv("db-services").join("\n"), -1)

    const dbFrame = new Gtk.Frame({
      child: dbEntry,
      margin_start: 12,
      margin_end: 12,
      margin_top: 4,
      margin_bottom: 4,
    })
    dbFrame.set_size_request(-1, 80)
    dbGroup.add(dbFrame)

    // --- Valet binary path ---
    const pathGroup = new Adw.PreferencesGroup({
      title: "Ruta de Valet",
      description:
        "Ruta completa al binario de valet. Se usa para start/stop del stack.",
    })
    page.add(pathGroup)

    const pathRow = new Adw.EntryRow({
      title: "valet-path",
      text: settings.get_string("valet-path"),
    })
    pathGroup.add(pathRow)

    // --- Save on close ---
    window.connect("close-request", () => {
      const parseBuf = (buf) => {
        const [start, end] = [buf.get_start_iter(), buf.get_end_iter()]
        return buf
          .get_text(start, end, false)
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      }

      settings.set_strv("valet-services", parseBuf(valetEntry.get_buffer()))
      settings.set_strv("db-services", parseBuf(dbEntry.get_buffer()))
      settings.set_string("valet-path", pathRow.text)
    })
  }
}
