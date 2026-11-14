set -gx CODR_TERMINAL 1
set -l script_dir (dirname (status filename))

function fish_prompt
    printf base
end

source "$script_dir/init.fish"

# Conda preserves the prompt installed from conf.d before wrapping it.
functions -c fish_prompt __fish_prompt_orig
function fish_prompt
    printf conda
    __fish_prompt_orig
end

__terax_install_prompt

set -l rendered (fish_prompt)
test (string match -ra conda -- "$rendered" | count) -eq 1; or exit 1
test (string match -ra base -- "$rendered" | count) -eq 1; or exit 1
test (string match -ra '133;D;' -- "$rendered" | count) -eq 1; or exit 1
test (string match -ra '133;A' -- "$rendered" | count) -eq 1; or exit 1
test (string match -ra '133;B' -- "$rendered" | count) -eq 1; or exit 1
test (string match -ra '7;file://' -- "$rendered" | count) -eq 1; or exit 1

# Replacements that preserve Conda's helper but do not delegate to it still
# need the post-config rewrap.
functions -e __terax_user_prompt fish_prompt
function fish_prompt
    printf replacement
end
__terax_install_prompt
set rendered (fish_prompt)
test (string match -ra replacement -- "$rendered" | count) -eq 1; or exit 1
test (string match -ra '133;D;' -- "$rendered" | count) -eq 1; or exit 1
test (string match -ra '133;A' -- "$rendered" | count) -eq 1; or exit 1
test (string match -ra '133;B' -- "$rendered" | count) -eq 1; or exit 1
test (string match -ra '7;file://' -- "$rendered" | count) -eq 1; or exit 1

python3 -c '
import os, pty, select, shutil, subprocess, sys, tempfile, time

init_fish = sys.argv[1]
post_c = "functions -q __terax_install_prompt; and __terax_install_prompt; functions -q __terax_enforce_space_isolation; and __terax_enforce_space_isolation"
failures = []

def check(label, cond, detail=""):
    if cond:
        print(f"ok   {label}")
    else:
        print(f"FAIL {label}: {detail}")
        failures.append(label)

def write_exec(path, body):
    with open(path, "w") as handle:
        handle.write(body)
    os.chmod(path, 0o755)

def run_fish_session(mode):
    with tempfile.TemporaryDirectory() as tmp:
        home = os.path.join(tmp, "home")
        xdg_cfg = os.path.join(tmp, "xdg", "config")
        xdg_data = os.path.join(tmp, "xdg", "data")
        xdg_state = os.path.join(tmp, "xdg", "state")
        xdg_cache = os.path.join(tmp, "xdg", "cache")
        shim_dir = os.path.join(tmp, "spaces", "sp-1", "bin")
        ctrl_dir = os.path.join(tmp, "ctrl", "bin")
        claude_dir = os.path.join(tmp, "spaces", "sp-1", "claude")
        opc_cfg = os.path.join(tmp, "spaces", "sp-1", "opencode", "config")
        opc_data = os.path.join(tmp, "spaces", "sp-1", "opencode", "data")
        opc_state = os.path.join(tmp, "spaces", "sp-1", "opencode", "state")
        opc_cache = os.path.join(tmp, "spaces", "sp-1", "opencode", "cache")
        for d in (
            os.path.join(home, ".local", "bin"),
            os.path.join(home, ".opencode", "bin"),
            os.path.join(xdg_cfg, "fish", "conf.d"),
            xdg_data, xdg_state, xdg_cache,
            shim_dir, ctrl_dir, claude_dir,
            opc_cfg, opc_data, opc_state, opc_cache,
        ):
            os.makedirs(d, exist_ok=True)

        shutil.copy2(init_fish, os.path.join(xdg_cfg, "fish", "conf.d", "codr.fish"))
        write_exec(
            os.path.join(shim_dir, "opencode"),
            f"#!/bin/sh\n"
            f"set -eu\n"
            f"SHIM_DIR=\x27{shim_dir}\x27\n"
            f"real_opencode=\"\"\n"
            f"old_ifs=\"${{IFS-}}\"\n"
            f"IFS=\":\"\n"
            f"for dir in ${{PATH-}}; do\n"
            f"  [ -n \"$dir\" ] || continue\n"
            f"  [ \"$dir\" = \"$SHIM_DIR\" ] && continue\n"
            f"  if [ -f \"$dir/opencode\" ] && [ -x \"$dir/opencode\" ]; then\n"
            f"    real_opencode=\"$dir/opencode\"\n"
            f"    break\n"
            f"  fi\n"
            f"done\n"
            f"IFS=\"$old_ifs\"\n"
            f"[ -n \"$real_opencode\" ] || exit 127\n"
            f"export XDG_DATA_HOME=\x27{opc_data}\x27\n"
            f"export XDG_STATE_HOME=\x27{opc_state}\x27\n"
            f"export XDG_CACHE_HOME=\x27{opc_cache}\x27\n"
            f"export OPENCODE_CONFIG_DIR=\x27{opc_cfg}\x27\n"
            f"exec \"$real_opencode\" --standalone \"$@\"\n",
        )
        os.chmod(os.path.join(shim_dir, "opencode"), 0o700)
        write_exec(
            os.path.join(home, ".opencode", "bin", "opencode"),
            "#!/bin/sh\nprintf \"OPENCODE_EXEC:ARGS=%s|DATA=%s|STATE=%s|CACHE=%s|CFG=%s\\n\" \"$*\" \"${XDG_DATA_HOME-UNSET}\" \"${XDG_STATE_HOME-UNSET}\" \"${XDG_CACHE_HOME-UNSET}\" \"${OPENCODE_CONFIG_DIR-UNSET}\"\n",
        )
        write_exec(os.path.join(ctrl_dir, "terax"), "#!/bin/sh\necho CTRL_TERAX\n")
        write_exec(os.path.join(home, ".local", "bin", "terax"), "#!/bin/sh\necho HOST_TERAX\n")

        cfg_lines = [
            "function fish_prompt; printf \"fish> \"; end",
            "set -gx fish_greeting \"\"",
            "set -gx PATH \"$HOME/.opencode/bin\" \"$HOME/.local/bin\" $PATH",
            "fish_add_path -p \"$HOME/.local/bin\"",
            "set -gx OPENCODE_CONFIG_DIR \"$HOME/.config/opencode-fish-override\"",
        ]
        if mode != "universal":
            cfg_lines.extend([
                "set -gx OPENAI_API_KEY \"sk-openai-fish-leak\"",
                "set -gx OPENCODE_API_KEY \"sk-opencode-fish-leak\"",
                "set -gx GEMINI_API_KEY \"AIzaFishLeak123\"",
            ])
        if mode in ("isolated", "default"):
            cfg_lines.append("set -gx ANTHROPIC_API_KEY \"sk-ant-fish-leak\"")
        with open(os.path.join(xdg_cfg, "fish", "config.fish"), "w") as handle:
            handle.write("\n".join(cfg_lines) + "\n")

        env = os.environ.copy()
        for k in (
            "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENCODE_API_KEY", "GEMINI_API_KEY",
            "CODR_SPACE_SHIM_DIR", "CODR_SPACE_ENV_OVERRIDE_KEYS", "CODR_CONTROL_BIN_DIR",
            "CLAUDE_CONFIG_DIR",
        ):
            env.pop(k, None)
        env["HOME"] = home
        env["XDG_CONFIG_HOME"] = xdg_cfg
        env["XDG_DATA_HOME"] = xdg_data
        env["XDG_STATE_HOME"] = xdg_state
        env["XDG_CACHE_HOME"] = xdg_cache
        env["CODR_TERMINAL"] = "1"
        env["CODR_CONTROL_BIN_DIR"] = ctrl_dir
        env["fish_features"] = "no-mark-prompt"
        if mode in ("isolated", "override", "universal"):
            env["CODR_SPACE_SHIM_DIR"] = shim_dir
            env["CLAUDE_CONFIG_DIR"] = claude_dir
            env["PATH"] = f"{shim_dir}:{ctrl_dir}:/usr/bin:/bin"
            if mode == "override":
                env["ANTHROPIC_API_KEY"] = "sk-ant-space-override"
                env["CODR_SPACE_ENV_OVERRIDE_KEYS"] = "ANTHROPIC_API_KEY"
            if mode == "universal":
                subprocess.run(
                    ["fish", "-c", "set -Ux OPENAI_API_KEY sk-universal-fish-secret"],
                    env=env,
                    check=True,
                )
        else:
            env["PATH"] = f"{ctrl_dir}:/usr/bin:/bin"

        pid, fd = pty.fork()
        if pid == 0:
            os.execvpe("fish", ["fish", "-i", "-C", post_c], env)

        out = b""
        def drain(seconds):
            nonlocal out
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

        def send(cmd, wait=1.0):
            os.write(fd, (cmd + "\n").encode())
            drain(wait)

        drain(1.5)
        send(
            "printf \"MAIN:OC=%s|TX=%s|ANT=%s|OAI=%s|OPC=%s|GEM=%s|HOME=%s|XCFG=%s|XDATA=%s|OPCCFG=%s|CLAUDE=%s|SHIM=%s\\n\" "
            "(command -v opencode) (command -v terax) "
            "(set -q ANTHROPIC_API_KEY; and echo $ANTHROPIC_API_KEY; or echo UNSET) "
            "(set -q OPENAI_API_KEY; and echo $OPENAI_API_KEY; or echo UNSET) "
            "(set -q OPENCODE_API_KEY; and echo $OPENCODE_API_KEY; or echo UNSET) "
            "(set -q GEMINI_API_KEY; and echo $GEMINI_API_KEY; or echo UNSET) "
            "\"$HOME\" \"$XDG_CONFIG_HOME\" \"$XDG_DATA_HOME\" "
            "(set -q OPENCODE_CONFIG_DIR; and test -n \"$OPENCODE_CONFIG_DIR\"; and echo $OPENCODE_CONFIG_DIR; or echo UNSET) "
            "(set -q CLAUDE_CONFIG_DIR; and echo $CLAUDE_CONFIG_DIR; or echo UNSET) "
            "(set -q CODR_SPACE_SHIM_DIR; and echo $CODR_SPACE_SHIM_DIR; or echo UNSET)"
        )
        send("opencode run fish-turn")
        send(
            "printf \"AFTER_FISH_OC:XDATA=%s|OPCCFG=%s\\n\" \"$XDG_DATA_HOME\" "
            "(set -q OPENCODE_CONFIG_DIR; and test -n \"$OPENCODE_CONFIG_DIR\"; and echo $OPENCODE_CONFIG_DIR; or echo UNSET)"
        )
        send("sh -c \x27printf \"SH:OC=%s|OAI=%s|CLAUDE=%s\\n\" \"$(command -v opencode)\" \"${OPENAI_API_KEY-UNSET}\" \"${CLAUDE_CONFIG_DIR-UNSET}\"; opencode run fish-sub\x27")
        if mode == "isolated":
            send("fish -i")
            send(
                "printf \"NESTED_FISH:OC=%s|ANT=%s|GEM=%s\\n\" "
                "(command -v opencode) "
                "(set -q ANTHROPIC_API_KEY; and echo $ANTHROPIC_API_KEY; or echo UNSET) "
                "(set -q GEMINI_API_KEY; and echo $GEMINI_API_KEY; or echo UNSET)"
            )
            send("exit", wait=0.5)
        send("exit", wait=0.5)
        os.close(fd)
        os.waitpid(pid, 0)
        persisted = ""
        if mode == "universal":
            persisted = subprocess.check_output(
                ["fish", "-c", "echo $OPENAI_API_KEY"],
                env=env,
                text=True,
            ).strip()
        return out.decode("utf-8", "replace"), home, xdg_cfg, shim_dir, ctrl_dir, claude_dir, persisted

iso_out, iso_home, iso_xcfg, iso_shim, iso_ctrl, iso_claude, _ = run_fish_session("isolated")
check("fish isolated: opencode resolves to Space shim ahead of config.fish", f"MAIN:OC={iso_shim}/opencode|" in iso_out, iso_out)
check("fish isolated: control terax stays ahead of ~/.local/bin", f"|TX={iso_ctrl}/terax|" in iso_out, iso_out)
check("fish isolated: all 4 ambient keys are scrubbed", "|ANT=UNSET|OAI=UNSET|OPC=UNSET|GEM=UNSET|" in iso_out, iso_out)
check("fish isolated: host HOME and XDG_CONFIG_HOME stay intact", f"|HOME={iso_home}|XCFG={iso_xcfg}|" in iso_out, iso_out)
check("fish isolated: dotfile OPENCODE_CONFIG_DIR is scrubbed on shell", "|OPCCFG=UNSET|" in iso_out, iso_out)
check("fish isolated: opencode shim passes --standalone and Space-scoped XDG/OPENCODE_CONFIG_DIR", "OPENCODE_EXEC:ARGS=--standalone run fish-turn|" in iso_out and "/spaces/sp-1/opencode/data|STATE=" in iso_out, iso_out)
check("fish isolated: shell XDG_DATA_HOME and OPENCODE_CONFIG_DIR stay untouched after opencode exits", "|OPCCFG=UNSET" in iso_out and "AFTER_FISH_OC:XDATA=" in iso_out, iso_out)
check("fish isolated: child sh inherits Space shim, scrubbed key, and CLAUDE_CONFIG_DIR", f"SH:OC={iso_shim}/opencode|OAI=UNSET|CLAUDE={iso_claude}" in iso_out, iso_out)
check("fish isolated: child sh opencode invocation uses Space shim and --standalone", "OPENCODE_EXEC:ARGS=--standalone run fish-sub|" in iso_out, iso_out)
check("fish isolated: nested interactive fish enforces shim and scrubs keys", f"NESTED_FISH:OC={iso_shim}/opencode|ANT=UNSET|GEM=UNSET" in iso_out, iso_out)
for leaked in ("sk-ant-fish-leak", "sk-openai-fish-leak", "sk-opencode-fish-leak", "AIzaFishLeak123"):
    check(f"fish isolated: no leaked secret {leaked}", leaked not in iso_out)

ovr_out, _, _, ovr_shim, _, _, _ = run_fish_session("override")
check("fish override: opencode resolves to Space shim", f"MAIN:OC={ovr_shim}/opencode|" in ovr_out, ovr_out)
check("fish override: explicit ANTHROPIC_API_KEY survives while others scrub", "|ANT=sk-ant-space-override|OAI=UNSET|OPC=UNSET|GEM=UNSET|" in ovr_out, ovr_out)

def_out, def_home, _, _, _, _, _ = run_fish_session("default")
check("fish default: config.fish opencode PATH stays active", f"MAIN:OC={def_home}/.opencode/bin/opencode|" in def_out, def_out)
check("fish default: config.fish ANTHROPIC_API_KEY is left alone", "|ANT=sk-ant-fish-leak|" in def_out, def_out)

uni_out, _, _, _, _, _, persisted = run_fish_session("universal")
check("fish universal: does not leak universal secret into child sh", "sk-universal-fish-secret" not in uni_out, uni_out)
check("fish universal: host fish_variables remains intact on disk", persisted == "sk-universal-fish-secret", persisted)

sys.exit(1 if failures else 0)
' "$script_dir/init.fish"; or exit 1
