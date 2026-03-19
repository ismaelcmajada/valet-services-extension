#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -eq 0 ]]; then
  echo "Ejecuta este script como usuario normal, no con sudo."
  exit 1
fi

SCHEMA="org.gnome.shell.extensions.valet-services"

# --- Parse GSettings strv into bash array ---
read_strv() {
  local key="$1"
  gsettings get "$SCHEMA" "$key" \
    | sed "s/^\[//; s/\]$//; s/', '/"$'\n'"'/g; s/^'//; s/'$//" \
    | sed '/^$/d'
}

readarray -t SERVICES < <(read_strv "valet-services")
readarray -t PRE_START < <(read_strv "pre-start-commands")
readarray -t POST_START < <(read_strv "post-start-commands")
readarray -t PRE_STOP < <(read_strv "pre-stop-commands")
readarray -t POST_STOP < <(read_strv "post-stop-commands")

if [[ ${#SERVICES[@]} -eq 0 ]]; then
  echo "No hay servicios configurados en valet-services."
  exit 0
fi

escape_single() {
  printf "%s" "$1" | sed "s/'/'\\\\''/g"
}

for service in "${SERVICES[@]}"; do
  [[ -z "$service" ]] && continue
  [[ "$service" != *.service ]] && service="${service}.service"

  dir="/etc/systemd/system/${service}.d"
  file="${dir}/10-valet-hooks.conf"

  sudo mkdir -p "$dir"

  {
    echo "[Service]"
    echo "ExecStartPre="
    echo "ExecStartPost="
    echo "ExecStopPre="
    echo "ExecStopPost="

    for cmd in "${PRE_START[@]}"; do
      printf "ExecStartPre=/usr/bin/bash -lc '%s'\n" "$(escape_single "$cmd")"
    done

    for cmd in "${POST_START[@]}"; do
      printf "ExecStartPost=/usr/bin/bash -lc '%s'\n" "$(escape_single "$cmd")"
    done

    for cmd in "${PRE_STOP[@]}"; do
      printf "ExecStopPre=/usr/bin/bash -lc '%s'\n" "$(escape_single "$cmd")"
    done

    for cmd in "${POST_STOP[@]}"; do
      printf "ExecStopPost=/usr/bin/bash -lc '%s'\n" "$(escape_single "$cmd")"
    done
  } | sudo tee "$file" > /dev/null

  echo "✔ ${service} → ${file}"
done

sudo systemctl daemon-reload
echo
echo "Overrides aplicados y daemon-reload ejecutado."
