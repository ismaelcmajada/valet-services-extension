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

readarray -t SERVICES < <(read_strv "hook-services")
readarray -t PREV_SERVICES < <(read_strv "applied-hook-services")
readarray -t PRE_START < <(read_strv "pre-start-commands")
readarray -t POST_START < <(read_strv "post-start-commands")
readarray -t PRE_STOP < <(read_strv "pre-stop-commands")
readarray -t POST_STOP < <(read_strv "post-stop-commands")

has_hooks=false
if [[ ${#PRE_START[@]} -gt 0 || ${#POST_START[@]} -gt 0 || \
      ${#PRE_STOP[@]} -gt 0 || ${#POST_STOP[@]} -gt 0 ]]; then
  has_hooks=true
fi

escape_single() {
  printf "%s" "$1" | sed "s/'/'\\\\''/g"
}

normalize() {
  local s="$1"
  [[ "$s" != *.service ]] && s="${s}.service"
  echo "$s"
}

# --- Build set of current services for quick lookup ---
declare -A current_set
for service in "${SERVICES[@]}"; do
  [[ -z "$service" ]] && continue
  current_set["$(normalize "$service")"]=1
done

# --- Clean up stale overrides from previously applied services ---
for prev in "${PREV_SERVICES[@]}"; do
  [[ -z "$prev" ]] && continue
  prev="$(normalize "$prev")"

  if [[ -z "${current_set[$prev]+_}" ]]; then
    dir="/etc/systemd/system/${prev}.d"
    file="${dir}/10-valet-hooks.conf"
    if [[ -f "$file" ]]; then
      sudo rm -f "$file"
      sudo rmdir --ignore-fail-on-non-empty "$dir" 2>/dev/null || true
      echo "🗑 ${prev} → eliminado (ya no seleccionado)"
    fi
  fi
done

# --- Apply or clean current services ---
applied=()

for service in "${SERVICES[@]}"; do
  [[ -z "$service" ]] && continue
  service="$(normalize "$service")"

  dir="/etc/systemd/system/${service}.d"
  file="${dir}/10-valet-hooks.conf"

  if [[ "$has_hooks" == false ]]; then
    if [[ -f "$file" ]]; then
      sudo rm -f "$file"
      sudo rmdir --ignore-fail-on-non-empty "$dir" 2>/dev/null || true
      echo "🗑 ${service} → eliminado (sin hooks)"
    else
      echo "— ${service} → sin override previo"
    fi
    continue
  fi

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

  applied+=("$service")
  echo "✔ ${service} → ${file}"
done

# --- Update applied-hook-services in GSettings ---
if [[ ${#applied[@]} -eq 0 ]]; then
  gsettings set "$SCHEMA" applied-hook-services "[]"
else
  list=""
  for s in "${applied[@]}"; do
    [[ -n "$list" ]] && list+=", "
    list+="'$s'"
  done
  gsettings set "$SCHEMA" applied-hook-services "[$list]"
fi

sudo systemctl daemon-reload
echo
echo "Overrides aplicados y daemon-reload ejecutado."
