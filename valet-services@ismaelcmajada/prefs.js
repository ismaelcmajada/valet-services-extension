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

    // --- Save on close ---
    window.connect("close-request", () => {
      settings.set_strv("valet-services", parseBuf(valetEntry.get_buffer()))
      settings.set_strv("db-services", parseBuf(dbEntry.get_buffer()))
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
    })
  }
}
