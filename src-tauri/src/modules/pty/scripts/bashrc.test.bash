#!/usr/bin/env bash
# Shell integration tests for bashrc.bash. Run: bash bashrc.test.bash
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rcfile="$script_dir/bashrc.bash"
failures=0
unset CODR_BLOCKS CODR_CLI __CODR_HOOKS_LOADED _terax_block_seen

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf 'ok   %s\n' "$label"
  else
    printf 'FAIL %s: expected %s, got %s\n' "$label" "$expected" "$actual"
    failures=$((failures + 1))
  fi
}

# --- cwd reporting ----------------------------------------------------------
# Drives the rc file in a pty and prints one line per OSC 7 path reported.
cwd_reports() {
  HOME="$1" python3 - "$rcfile" <<'PY'
import os, pty, re, select, sys, time

pid, fd = pty.fork()
if pid == 0:
    os.execvp("bash", ["bash", "--rcfile", sys.argv[1], "-i"])

out = b""

def drain(seconds):
    global out
    end = time.time() + seconds
    while time.time() < end:
        if select.select([fd], [], [], 0.2)[0]:
            try:
                out += os.read(fd, 65536)
            except OSError:
                return
drain(2.0)
for line in ("cd /etc\n", "cd /usr\n", "exit\n"):
    os.write(fd, line.encode())
    drain(1.0)

# OSC 7 payload is file://<host><path>; keep the path, drop the host.
text = out.decode("utf-8", "replace")
for path in re.findall(r"\]7;file://[^/\x1b\x07]*([^\x1b\x07]*)", text):
    print(path.rstrip("/") or "/")
PY
}

empty_home="$(mktemp -d)"
trap 'rm -rf "$empty_home"' EXIT

reported="$(cwd_reports "$empty_home")"
check "reports cwd after cd /etc" 1 "$(printf '%s\n' "$reported" | grep -c '^/etc$')"
check "reports cwd after cd /usr" 1 "$(printf '%s\n' "$reported" | grep -c '^/usr$')"

# --- hook installation ------------------------------------------------------
# Sources the rc file with a fake environment and runs a probe against it.
# Stubbing ble.sh keeps this deterministic: a real ble.sh owns the line editor
# and released builds will not accept piped input at all, so there is no
# portable way to make one run a command from a test. The stub mirrors what
# matters about it: blehook keeps its own list, and an attached ble.sh restores
# its own copy of PROMPT_COMMAND before every prompt.
integration() {
  local fake_ble="$1" probe="$2" prompt_command="${3-}"
  HOME="$empty_home" TERAX_FAKE_BLE="$fake_ble" TERAX_PROBE="$probe" \
    TERAX_PC="$prompt_command" bash --norc --noprofile -c '
    PS1="user> "
    case "$TERAX_PC" in
      "") ;;
      "("*) eval "PROMPT_COMMAND=$TERAX_PC" ;;
      *) PROMPT_COMMAND="$TERAX_PC" ;;
    esac
    if [ -n "$TERAX_FAKE_BLE" ]; then
      BLE_VERSION=0.4.0-test
      BLEHOOKS=
      blehook() { BLEHOOKS="$BLEHOOKS$*;"; }
    fi
    source "$1" >/dev/null 2>&1
    eval "$TERAX_PROBE"
  ' _ "$rcfile" 2>/dev/null
}

contains() {
  case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac
}

expect_contains() {
  if contains "$3" "$2"; then check "$1" pass pass; else check "$1" pass "missing: $2 in $3"; fi
}

expect_lacks() {
  if contains "$3" "$2"; then check "$1" pass "unexpected: $2"; else check "$1" pass pass; fi
}

# Without a line editor, the PROMPT_COMMAND chain is the only hook point.
plain="$(integration "" 'printf "PROMPT_COMMAND:%s|BLEHOOKS:%s\n" "${PROMPT_COMMAND-}" "${BLEHOOKS-}"')"
expect_contains "plain bash hooks PROMPT_COMMAND" "PROMPT_COMMAND:_terax_precmd" "$plain"
expect_contains "plain bash never touches blehook" "BLEHOOKS:" "$plain"
expect_lacks "plain bash registers no ble.sh hook" "PRECMD" "$plain"

# Regression: an attached ble.sh manages its own copy of PROMPT_COMMAND, which
# has already been handed over by the time the hook is appended to it. Our hook
# was silently dropped, so the host saw one OSC 7 at startup and nothing on cd.
# ble.sh's own hook list survives that handover.
with_ble="$(integration 1 'printf "PROMPT_COMMAND:%s|BLEHOOKS:%s\n" "${PROMPT_COMMAND-}" "${BLEHOOKS-}"')"
expect_contains "ble.sh gets a blehook PRECMD, once-only form" "BLEHOOKS:PRECMD!=_terax_ble_precmd;" "$with_ble"
expect_contains "ble.sh keeps PROMPT_COMMAND too" "PROMPT_COMMAND:_terax_precmd" "$with_ble"

# The ble.sh entry reports the prompt when PROMPT_COMMAND was dropped by ble.sh.
dropped="$(integration 1 'PROMPT_COMMAND=; (exit 3); _terax_ble_precmd; printf "|status=%s" "$?"')"
expect_contains "ble.sh entry reports the command status" "133;D;3" "$dropped"
expect_contains "ble.sh entry reports the cwd" "]7;file://" "$dropped"
expect_contains "ble.sh entry marks the prompt start" "133;A" "$dropped"
expect_contains "ble.sh entry preserves the status" "|status=3" "$dropped"

# ...and stays silent when PROMPT_COMMAND will run the hook anyway, so a prompt
# is never reported twice.
shared="$(integration 1 '(exit 5); _terax_ble_precmd; printf "|status=%s" "$?"')"
expect_lacks "ble.sh entry does not repeat a PROMPT_COMMAND hook" "133;D" "$shared"
expect_contains "the skipped ble.sh entry preserves the status" "|status=5" "$shared"

# An array PROMPT_COMMAND and one with a trailing separator both keep working.
# The chain is asserted by shape, not by exact string: `/etc/profile` on Fedora appends
# `__systemd_osc_context_precmdline` (twice: /etc/profile.d and /etc/bashrc both run it), and a
# scalar PROMPT_COMMAND becomes an array when that happens. Both shapes must keep the user's
# entries in order with _terax_precmd first and the prompt end last, and the foreign entry must
# survive: dropping it would silently disable the session's own context reporting.
chain_entries='printf "%s\n" "${PROMPT_COMMAND[@]}"'
array="$(integration "" "$chain_entries" 'echo user;')"
check "scalar PROMPT_COMMAND starts with the precmd hook" \
  "_terax_precmd" "$(printf '%s\n' "$array" | head -n1 | cut -d';' -f1)"
expect_contains "scalar PROMPT_COMMAND keeps the user entry" "echo user;" "$array"
check "scalar PROMPT_COMMAND ends with the prompt end" \
  "_terax_finish_prompt" "$(printf '%s\n' "$array" | tail -n1)"

foreign="$(integration "" 'printf "%s\n" "${PROMPT_COMMAND[@]}"' 'echo user;'; true)"
# A hook appended by the host's own init is the case this host actually has; prove it is kept.
if grep -q '__systemd_osc_context_precmdline' <<<"$foreign"; then
  expect_contains "a host PROMPT_COMMAND hook survives the integration" \
    "__systemd_osc_context_precmdline" "$foreign"
fi

# --- precmd behaviour -------------------------------------------------------
status_after="$(integration "" '(exit 7); _terax_precmd >/dev/null; printf "%s" "$?"')"
check "precmd returns the status it was given" 7 "$status_after"

# The prompt end runs last in PROMPT_COMMAND, after every framework that rebuilds
# PS1. Bash before 4.4 tags the marker as having no PS0 to pair with.
prompt_end="$(integration "" 'PS1="user> "; _terax_finish_prompt; printf "%s" "$PS1"')"
check "prompt end follows the prompt text" 'user> \[\e]133;B\e\\\]' "${prompt_end/;terax_blocks=0/}"

reinjected="$(integration "" '
  _terax_finish_prompt
  PS1="framework> "
  _terax_finish_prompt
  _terax_finish_prompt
  printf "%s" "$PS1"')"
check "prompt end is restored once after a framework rebuilt PS1" 'framework> \[\e]133;B\e\\\]' "${reinjected/;terax_blocks=0/}"

finish_status="$(integration "" '(exit 9); _terax_finish_prompt; printf "%s" "$?"')"
check "the prompt end hook keeps the status too" 9 "$finish_status"

last_scalar="$(integration "" "$chain_entries" 'starship_precmd')"
check "the prompt end is the last PROMPT_COMMAND entry" \
  "_terax_finish_prompt" "$(printf '%s\n' "$last_scalar" | tail -n1)"
# On a host with no system hook the framework entry shares one line with the precmd hook, so the
# assertion is containment, not equality (the Ubuntu CI runner is that host).
expect_contains "the prompt framework entry is kept after the precmd hook" \
  "starship_precmd" "$last_scalar"
check "the precmd hook is still first with a framework entry" \
  "_terax_precmd" "$(printf '%s\n' "$last_scalar" | head -n1 | cut -d';' -f1)"

# On bash before 5.1 an array PROMPT_COMMAND runs only element 0, so that
# element has to carry both hooks; from 5.1 every element runs.
case "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}" in
  5.[1-9]*|[6-9].*)
    array_last="$(integration "" "$chain_entries" '(one two)')"
    check "an array PROMPT_COMMAND keeps the precmd hook first" \
      "_terax_precmd" "$(printf '%s\n' "$array_last" | head -n1 | cut -d';' -f1)"
    expect_contains "an array PROMPT_COMMAND keeps its first user entry" "one" "$array_last"
    expect_contains "an array PROMPT_COMMAND keeps its second user entry" "two" "$array_last"
    check "an array PROMPT_COMMAND ends with the prompt end" \
      "_terax_finish_prompt" "$(printf '%s\n' "$array_last" | tail -n1)"
    ;;
  *)
    array_last="$(integration "" 'printf "%s|" "${PROMPT_COMMAND[@]}"' '(one two)')"
    check "an old bash array keeps its element 0 as one command" "_terax_precmd;one"$'\n'"_terax_finish_prompt|two|" "$array_last"
    ;;
esac

nounset="$(integration "" 'set -u; unset CODR_BLOCKS _terax_block_seen; unset PS1; _terax_precmd >/dev/null; _terax_finish_prompt; printf ok')"
check "the hooks do not abort under set -u" ok "$nounset"

nounset_ble="$(integration 1 'set -u; unset PROMPT_COMMAND; _terax_ble_precmd >/dev/null; printf ok')"
check "the ble.sh entry does not abort under set -u without a PROMPT_COMMAND" ok "$nounset_ble"

# The last entry, whatever PROMPT_COMMAND's shape: a host hook may have turned the scalar into an
# array before this point, and `$PROMPT_COMMAND` would then print element 0 only.
ble_last="$(integration 1 'PROMPT_COMMAND=; _terax_ble_precmd >/dev/null; printf "%s" "${PROMPT_COMMAND[*]}"')"
check "the ble.sh entry puts the prompt end back last" _terax_finish_prompt "${ble_last##* }"

# ble.sh restores its own PROMPT_COMMAND before every prompt, so the entry runs
# in full each time: a fork there is latency on every prompt. A subshell shows
# up as a different $BASHPID (bash 4+) and as a call to the shadowed builtins
# or tools a command substitution or `(exit n)` would have needed.
fork_log="$empty_home/forks"
fork_cwd="$empty_home/with space & 100%"
mkdir -p "$fork_cwd"
: > "$fork_log"
export TERAX_FORK_LOG="$fork_log" TERAX_FORK_CWD="$fork_cwd"
fork_probe='
  cd "$TERAX_FORK_CWD"
  REPLY=user-value
  st() { return "$1"; }
  declare() { echo declare >> "$TERAX_FORK_LOG"; builtin declare "$@"; }
  uname() { echo uname >> "$TERAX_FORK_LOG"; command uname "$@"; }
  exit() { echo exit >> "$TERAX_FORK_LOG"; builtin exit "$@"; }
  set -T
  trap '"'"'[ "${BASHPID-$$}" = "$$" ] || echo subshell >> "$TERAX_FORK_LOG"'"'"' DEBUG
  PROMPT_COMMAND=; st 4; _terax_ble_precmd
  PROMPT_COMMAND=(one two); st 5; _terax_ble_precmd
  PROMPT_COMMAND=; st 6; _terax_ble_precmd
  trap - DEBUG
  printf "|%s|reply=%s" "${PROMPT_COMMAND[*]}" "$REPLY"'
forked="$(integration 1 "$fork_probe")"
expect_contains "the ble.sh entry reports with an encoded cwd" "with%20space%20%26%20100%25" "$forked"
expect_contains "the ble.sh entry reports each command status" "133;D;6" "$forked"
expect_contains "the prompt preserves the user REPLY" "reply=user-value" "$forked"
check "the ble.sh entry forks nothing per prompt" "" "$(cat "$fork_log")"
unset TERAX_FORK_LOG TERAX_FORK_CWD

# A prompt framework that rebuilds PS1 on every prompt, the way starship does,
# must still end each prompt with the marker: drive a real bash through it.
framework_prompts() {
  local home="$1"
  printf 'fw() { PS1="fw> "; }\nPROMPT_COMMAND=fw\n' > "$home/.bashrc"
  HOME="$home" python3 - "$rcfile" <<'PY'
import os, pty, re, select, sys, time

pid, fd = pty.fork()
if pid == 0:
    os.execvp("bash", ["bash", "--rcfile", sys.argv[1], "-i"])
out = b""

def drain(seconds):
    global out
    end = time.time() + seconds
    while time.time() < end:
        if select.select([fd], [], [], 0.2)[0]:
            try:
                out += os.read(fd, 65536)
            except OSError:
                return
drain(2.0)
for line in ("true\n", "false\n", "exit\n"):
    os.write(fd, line.encode())
    drain(1.0)

text = out.decode("utf-8", "replace")
a = len(re.findall(r"\x1b\]133;A", text))
b = len(re.findall(r"\x1b\]133;B", text))
after_text = len(re.findall(r"fw> \x1b\]133;B", text))
print(f"A={a} B={b} AFTER={after_text}")
PY
}
framework_home="$(mktemp -d)"
result="$(framework_prompts "$framework_home")"
rm -rf "$framework_home"
a="${result#A=}"; a="${a%% *}"
after="${result##*AFTER=}"
check "every prompt of a PS1-rebuilding framework ends with the prompt end after its text" 1 "$([ "$a" -ge 3 ] && [ "$after" -ge 3 ] && echo 1 || echo "$result")"

space_isolation_pty() {
  local mode="$1"
  local tmp
  tmp="$(mktemp -d)"
  local home="$tmp/home"
  local shim_dir="$tmp/spaces/sp-1/bin"
  local ctrl_dir="$tmp/ctrl/bin"
  local claude_dir="$tmp/spaces/sp-1/claude"
  local xdg_cfg="$tmp/xdg/config"
  local xdg_data="$tmp/xdg/data"
  local xdg_state="$tmp/xdg/state"
  local xdg_cache="$tmp/xdg/cache"
  mkdir -p "$home/.local/bin" "$home/.opencode/bin" "$shim_dir" "$ctrl_dir" "$claude_dir" \
           "$xdg_cfg" "$xdg_data" "$xdg_state" "$xdg_cache"

  cat > "$shim_dir/opencode" <<'SH'
#!/bin/sh
echo "SHIM_OPENCODE"
SH
  cat > "$home/.opencode/bin/opencode" <<'SH'
#!/bin/sh
echo "HOST_OPENCODE"
SH
  cat > "$ctrl_dir/terax" <<'SH'
#!/bin/sh
echo "CTRL_TERAX"
SH
  cat > "$home/.local/bin/terax" <<'SH'
#!/bin/sh
echo "HOST_TERAX"
SH
  chmod 755 "$shim_dir/opencode" "$home/.opencode/bin/opencode" "$ctrl_dir/terax" "$home/.local/bin/terax"

  cat > "$home/.bash_profile" <<'RC'
export PATH="$HOME/.local/bin:$PATH"
export OPENAI_API_KEY="sk-openai-profile-leak"
RC

  cat > "$home/.bashrc" <<'RC'
PS1='iso> '
export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"
export OPENAI_API_KEY="sk-openai-rc-leak"
export OPENCODE_API_KEY="sk-opencode-rc-leak"
export GEMINI_API_KEY="AIzaRcLeak123456"
RC
  if [ "$mode" = "isolated" ] || [ "$mode" = "default" ]; then
    printf 'export ANTHROPIC_API_KEY="sk-ant-rc-leak"\n' >> "$home/.bashrc"
  fi

  python3 - "$rcfile" "$mode" "$tmp" "$home" "$shim_dir" "$ctrl_dir" "$claude_dir" \
    "$xdg_cfg" "$xdg_data" "$xdg_state" "$xdg_cache" <<'PY'
import os, pty, select, sys, time

rcfile, mode, tmp, home, shim_dir, ctrl_dir, claude_dir, xdg_cfg, xdg_data, xdg_state, xdg_cache = sys.argv[1:12]

env = os.environ.copy()
for k in [
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENCODE_API_KEY", "GEMINI_API_KEY",
    "CODR_SPACE_SHIM_DIR", "CODR_SPACE_ENV_OVERRIDE_KEYS", "CODR_CONTROL_BIN_DIR",
    "CLAUDE_CONFIG_DIR", "__CODR_HOOKS_LOADED",
]:
    env.pop(k, None)

env["HOME"] = home
env["XDG_CONFIG_HOME"] = xdg_cfg
env["XDG_DATA_HOME"] = xdg_data
env["XDG_STATE_HOME"] = xdg_state
env["XDG_CACHE_HOME"] = xdg_cache
env["CODR_TERMINAL"] = "1"
env["CODR_CONTROL_BIN_DIR"] = ctrl_dir

if mode in ("isolated", "override"):
    env["CODR_SPACE_SHIM_DIR"] = shim_dir
    env["CLAUDE_CONFIG_DIR"] = claude_dir
    env["PATH"] = f"{shim_dir}:{ctrl_dir}:/usr/bin:/bin"
    if mode == "override":
        env["ANTHROPIC_API_KEY"] = "sk-ant-space-override"
        env["CODR_SPACE_ENV_OVERRIDE_KEYS"] = "ANTHROPIC_API_KEY"
else:
    env["PATH"] = f"{ctrl_dir}:/usr/bin:/bin"

pid, fd = pty.fork()
if pid == 0:
    os.execvpe("bash", ["bash", "--rcfile", rcfile, "-i"], env)

out = b""
def drain(seconds):
    global out
    end = time.time() + seconds
    while time.time() < end:
        if select.select([fd], [], [], 0.1)[0]:
            try:
                chunk = os.read(fd, 65536)
                if not chunk:
                    return
                out += chunk
            except OSError:
                return

drain(1.0)
probe = "\n".join([
    'printf "PROBE:OC=%s|TX=%s|ANT=%s|OAI=%s|OPC=%s|GEM=%s|HOME=%s|XCFG=%s|CLAUDE=%s|SHIM=%s\\n" '
    '"$(command -v opencode)" "$(command -v terax)" '
    '"${ANTHROPIC_API_KEY-UNSET}" "${OPENAI_API_KEY-UNSET}" "${OPENCODE_API_KEY-UNSET}" "${GEMINI_API_KEY-UNSET}" '
    '"$HOME" "$XDG_CONFIG_HOME" "${CLAUDE_CONFIG_DIR-UNSET}" "${CODR_SPACE_SHIM_DIR-UNSET}"',
    """sh -c 'printf "CHILD_SH:OC=%s|OAI=%s|CLAUDE=%s\\n" "$(command -v opencode)" "${OPENAI_API_KEY-UNSET}" "${CLAUDE_CONFIG_DIR-UNSET}"'""",
    """bash -c 'printf "CHILD_BASH:OC=%s|ANT=%s|SHIM=%s\\n" "$(command -v opencode)" "${ANTHROPIC_API_KEY-UNSET}" "${CODR_SPACE_SHIM_DIR-UNSET}"'""",
    """( printf 'SUBSHELL:OC=%s|GEM=%s\\n' "$(command -v opencode)" "${GEMINI_API_KEY-UNSET}" )""",
    "exit",
    "",
])
os.write(fd, probe.encode())
drain(1.5)
os.close(fd)
os.waitpid(pid, 0)
print(out.decode("utf-8", "replace"))
PY
  rm -rf "$tmp"
}

bash_iso_out="$(space_isolation_pty isolated)"
expect_contains "bash isolated: opencode path uses /spaces/sp-1/bin/opencode" "/spaces/sp-1/bin/opencode|" "$bash_iso_out"
expect_contains "bash isolated: control terax stays ahead of ~/.local/bin" "/ctrl/bin/terax|" "$bash_iso_out"
expect_contains "bash isolated: all 4 ambient keys are scrubbed" "|ANT=UNSET|OAI=UNSET|OPC=UNSET|GEM=UNSET|" "$bash_iso_out"
expect_contains "bash isolated: host HOME stays intact" "/home|XCFG=" "$bash_iso_out"
expect_contains "bash isolated: host XDG_CONFIG_HOME stays intact" "/xdg/config|CLAUDE=" "$bash_iso_out"
expect_contains "bash isolated: nested sh inherits shim, scrubbed keys, and claude dir" "/spaces/sp-1/bin/opencode|OAI=UNSET|CLAUDE=" "$bash_iso_out"
expect_contains "bash isolated: nested bash -c inherits shim and scrubbed ANTHROPIC_API_KEY" "/spaces/sp-1/bin/opencode|ANT=UNSET|SHIM=" "$bash_iso_out"
for leaked in sk-ant-rc-leak sk-openai-profile-leak sk-openai-rc-leak sk-opencode-rc-leak AIzaRcLeak123456; do
  if printf '%s' "$bash_iso_out" | grep -Fq "$leaked"; then
    failures=$((failures + 1))
    printf 'FAIL bash isolated: leaked ambient secret pattern %s\n' "$leaked"
  fi
done

bash_ovr_out="$(space_isolation_pty override)"
expect_contains "bash override: explicit ANTHROPIC_API_KEY override survives while others scrub" "|ANT=sk-ant-space-override|OAI=UNSET|OPC=UNSET|GEM=UNSET|" "$bash_ovr_out"

bash_def_out="$(space_isolation_pty default)"
expect_contains "bash default: user dotfile PATH and ambient key are left alone" "/.opencode/bin/opencode|" "$bash_def_out"
expect_contains "bash default: dotfile ANTHROPIC_API_KEY stays set in default mode" "|ANT=sk-ant-rc-leak|" "$bash_def_out"

exit $((failures > 0))
