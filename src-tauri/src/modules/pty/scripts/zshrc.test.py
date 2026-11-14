#!/usr/bin/env python3
"""Shell integration tests for the zsh scripts. Run: python3 zshrc.test.py

Drives a real zsh in a pty the way Terax spawns it (ZDOTDIR pointing at a copy
of these scripts) and checks the OSC 7 / OSC 133 stream and the ZDOTDIR
hand-off.
"""
import fcntl
import os
import pty
import re
import select
import shlex
import shutil
import struct
import sys
import tempfile
import termios
import time

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
ZSH = shutil.which("zsh")
if ZSH is None:
    print("skip: zsh is not installed")
    sys.exit(0)

OSC = re.compile(rb"\x1b\](\d+)(?:;([^\x07\x1b]*))?(?:\x07|\x1b\\)")
TIMEOUT = float(os.environ.get("TERAX_ZSH_TEST_TIMEOUT", "8"))
failures = 0
current = None


def check(label, ok, detail=""):
    global failures
    if ok:
        print(f"ok   {label}")
        return
    failures += 1
    print(f"FAIL {label} {detail}")
    # The first failure in a session shows what the shell actually sent, so a
    # CI log is enough to see why.
    if current is not None and not current.dumped:
        current.dumped = True
        print(f"---- raw output of the session (last 3000 bytes) ----\n{current.out[-3000:]!r}\n----")


def describe_environment():
    import subprocess

    version = subprocess.run([ZSH, "--version"], capture_output=True, text=True).stdout.strip()
    print(f"# {version} at {ZSH}")
    for path in ("/etc/zsh/zshenv", "/etc/zsh/zprofile", "/etc/zsh/zshrc", "/etc/zsh/zlogin", "/etc/zshenv", "/etc/zshrc"):
        if os.path.exists(path):
            print(f"# global {path} ({os.path.getsize(path)} bytes)")
            if os.environ.get("TERAX_ZSH_TEST_DEBUG"):
                with open(path, errors="replace") as handle:
                    print(handle.read())


class Session:
    def __init__(self, files, blocks=False, env=None):
        global current
        current = self
        self.dumped = False
        self.tmp = tempfile.mkdtemp(prefix="terax-zsh-test-")
        self.home = os.path.join(self.tmp, "home")
        self.zdotdir = os.path.join(self.tmp, "integration")
        os.makedirs(self.home)
        os.makedirs(self.zdotdir)
        for src, dst in (
            ("zshenv.zsh", ".zshenv"),
            ("zprofile.zsh", ".zprofile"),
            ("zshrc.zsh", ".zshrc"),
            ("zlogin.zsh", ".zlogin"),
        ):
            shutil.copy(os.path.join(SCRIPTS, src), os.path.join(self.zdotdir, dst))
        for rel, content in files.items():
            path = os.path.join(self.home, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as handle:
                handle.write(content.replace("@HOME@", self.home))
        # Ubuntu's /etc/zsh/zshrc runs compinit unless this is set, and compinit
        # stops at an "insecure directories" question on a machine whose fpath
        # has a group-writable directory (a CI runner, a container). That
        # question swallows the first typed character of every shell, with or
        # without Terax, so the tests keep it out of the way.
        user_dirs = [self.home]
        if env and "CODR_USER_ZDOTDIR" in env:
            user_dirs.append(env["CODR_USER_ZDOTDIR"].replace("@HOME@", self.home))
        for directory in user_dirs:
            os.makedirs(directory, exist_ok=True)
            path = os.path.join(directory, ".zshenv")
            existing = open(path).read() if os.path.exists(path) else ""
            with open(path, "w") as handle:
                handle.write("skip_global_compinit=1\n" + existing)
        child_env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": self.home,
            "TERM": "xterm-256color",
            "LANG": "C.UTF-8",
            "CODR_TERMINAL": "1",
            "SHELL": ZSH,
            "ZDOTDIR": self.zdotdir,
        }
        if blocks:
            child_env["CODR_BLOCKS"] = "1"
        for key, value in (env or {}).items():
            child_env[key] = value.replace("@HOME@", self.home)
        self.out = b""
        pid, self.fd = pty.fork()
        if pid == 0:
            os.chdir(self.home)
            os.execve(ZSH, ["zsh", "-l"], child_env)
        self.pid = pid
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 120, 0, 0))
        if not self.wait_for_prompts(1):
            check("the shell reaches its first prompt", False, "(nothing ended a prompt in time)")

    def prompts(self):
        return len(re.findall(rb"\x1b\]133;B", self.out))

    def pump(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            if select.select([self.fd], [], [], 0.05)[0]:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    return
                if not data:
                    return
                self.out += data

    def wait_for_prompts(self, count, timeout=None):
        end = time.time() + (TIMEOUT if timeout is None else timeout)
        while time.time() < end and self.prompts() < count:
            self.pump(0.05)
        self.pump(0.15)
        return self.prompts() >= count

    def run(self, line):
        before = self.prompts()
        os.write(self.fd, line.encode() + b"\r")
        return self.wait_for_prompts(before + 1)

    def close(self):
        try:
            os.write(self.fd, b"exit\r")
            self.pump(0.3)
            os.close(self.fd)
        except OSError:
            pass
        shutil.rmtree(self.tmp, ignore_errors=True)

    def events(self):
        """The stream as ("osc", number, arg) and ("text", str) tuples."""
        items, pos = [], 0
        for match in OSC.finditer(self.out):
            if match.start() > pos:
                items.append(("text", self.out[pos : match.start()].decode("utf-8", "replace")))
            items.append(("osc", match.group(1).decode(), (match.group(2) or b"").decode()))
            pos = match.end()
        items.append(("text", self.out[pos:].decode("utf-8", "replace")))
        return items

    def marks(self):
        return [
            f"{n}:{a}" if n == "133" else n
            for kind, *rest in self.events()
            if kind == "osc"
            for n, a in [rest[:2]]
            if n in ("133", "7")
        ]

    def result(self, name):
        found = re.findall(rf"RESULT:{name}=([^:\r\n]*):", self.out.decode("utf-8", "replace"))
        found = [value for value in found if "$" not in value]
        return found[-1] if found else None


def prompt_text_between_a_and_b(session):
    """Text drawn between each prompt start and the matching prompt end."""
    texts, current = [], None
    for kind, *rest in session.events():
        if kind == "osc" and rest[0] == "133" and rest[1] == "A":
            current = ""
        elif kind == "osc" and rest[0] == "133" and rest[1].startswith("B"):
            if current is not None:
                texts.append(current)
            current = None
        elif kind == "text" and current is not None:
            current += rest[0]
    return texts


describe_environment()

# --- the marker stream ------------------------------------------------------
s = Session({".zshrc": "PS1='PROMPT> '\n"})
s.run("true")
s.run("false")
marks = s.marks()
check("a command is bracketed by C and D with its status", "133:C;false" in marks and "133:D;1" in marks, marks)
check("every prompt starts with A and ends with B", marks.count("133:A") == marks.count("133:B"), marks)
check("prompt text sits between A and B", all("PROMPT> " in text for text in prompt_text_between_a_and_b(s)), prompt_text_between_a_and_b(s))
s.run("cd /tmp")
check("the new cwd is reported after cd", re.search(rb"\x1b\]7;file://[^/]*/(private/)?tmp\x1b", s.out) is not None)
s.run("mkdir -p \"$HOME/with space\"; cd \"$HOME/with space\"; REPLY=user-value")
s.run("printf 'RESULT:reply=%s:' \"$REPLY\"")
check("prompt cwd encoding preserves the user REPLY", s.result("reply") == "user-value", s.result("reply"))
s.close()

# A prompt framework that rebuilds PS1 in a precmd running after ours, the way
# powerlevel10k keeps its hook last, must still end up with a prompt end after
# its prompt text on every prompt.
late = """
late_prompt() {
  PS1='late> '
  precmd_functions=(${precmd_functions:#late_prompt} late_prompt)
}
precmd_functions+=(late_prompt)
"""
s = Session({".zshrc": late})
s.run("true")
s.run("true")
texts = prompt_text_between_a_and_b(s)
check("a framework that rebuilds PS1 last still gets a prompt end", len(texts) >= 3 and all("late> " in text for text in texts), texts)
check("exactly one prompt end per prompt", s.marks().count("133:A") == s.marks().count("133:B"), s.marks())
s.close()

# Another plugin that hooks line-init through add-zle-hook-widget installs the
# shared dispatcher before Terax does. That dispatcher being there says nothing
# about Terax's own hook, so the prompt end of a late-rebuilt prompt must still
# come, and the plugin's hook must keep running.
shared_dispatcher = late + """
autoload -Uz add-zle-hook-widget
plugin_line_init() { print -n -- PLUGIN_LINE_INIT_RAN }
add-zle-hook-widget line-init plugin_line_init
"""
s = Session({".zshrc": shared_dispatcher})
s.run("true")
s.run("true")
texts = prompt_text_between_a_and_b(s)
check("a shared line-init dispatcher does not keep Terax's hook out", len(texts) >= 3 and all("late> " in text for text in texts), texts)
check("the plugin's own line-init hook still runs", s.out.count(b"PLUGIN_LINE_INIT_RAN") >= 3, s.out.count(b"PLUGIN_LINE_INIT_RAN"))
s.close()

# A prompt that already carries its own end marker is not marked twice.
own = "PS1=$'PROMPT> %{\\e]133;B\\a%}'\n"
s = Session({".zshrc": own})
s.run("true")
check("a prompt with its own end marker is left alone", s.marks().count("133:A") == s.marks().count("133:B"), s.marks())
s.close()

# Block mode: the shell prompt is suppressed, only the markers remain.
s = Session({".zshrc": "PS1='PROMPT> '\n"}, blocks=True)
s.run("true")
check("block mode draws no shell prompt", "PROMPT> " not in s.out.decode("utf-8", "replace"))
check("block mode still ends the prompt", s.marks().count("133:B") >= 2)
s.close()

# User options that change how zsh reads arrays and unset variables must not
# break the integration.
s = Session({".zshrc": "PS1='PROMPT> '\nsetopt ksharrays nounset\n"})
s.run("true")
s.run("false")
text = s.out.decode("utf-8", "replace")
check("KSH_ARRAYS and NO_UNSET do not break the markers", s.marks().count("133:B") >= 3 and "133:D;1" in s.marks(), s.marks())
check("no parameter errors under those options", "parameter not set" not in text and "bad math" not in text, text[-200:])
s.close()

# --- ZDOTDIR ----------------------------------------------------------------
# ZDOTDIR has two faces: at the prompt and in hooks it is the user's own (the
# user's rc registers a precmd hook that records it), while a running command
# sees Terax's directory exported so a shell it starts is integrated again.
hook = "_probe() { PROBE_ZD=${ZDOTDIR-unset} }\nprecmd_functions+=(_probe)\n"
probe = (
    'print -r -- "RESULT:ZD=${PROBE_ZD-none}:"; print -r -- "RESULT:LOADED=${A_LOADED-no}:"; '
    'print -r -- "RESULT:HIST=${HISTFILE-none}:"; print -r -- "RESULT:USERVAR=${CODR_USER_ZDOTDIR-unset}:"; '
    'print -r -- "RESULT:CMDZD=${ZDOTDIR-unset}:"; '
    "print -r -- \"RESULT:ENVZD=$(command env | sed -n 's/^ZDOTDIR=//p'):\""
)
loader = (
    'for file in "${ZDOTDIR:-$HOME/.config/zsh}/conf.d/"*.zsh; do\n'
    '  [ -r "$file" ] && source "$file"\n'
    "done\n"
)

# The user keeps their dotfiles in $ZDOTDIR, exported before zsh starts.
s = Session(
    {
        ".config/zsh/.zshenv": loader,
        ".config/zsh/conf.d/a.zsh": "A_LOADED=yes\n",
        ".config/zsh/.zshrc": "PS1='PROMPT> '\n" + hook,
    },
    env={"CODR_USER_ZDOTDIR": "@HOME@/.config/zsh"},
)
s.run(probe)
text = s.out.decode("utf-8", "replace")
user_dir = os.path.join(s.home, ".config/zsh")
check("a $ZDOTDIR/conf.d loader in .zshenv finds the user's files", s.result("LOADED") == "yes", s.result("LOADED"))
check("no glob error from a $ZDOTDIR loader", "no matches found" not in text)
check("hooks and the prompt see the user's ZDOTDIR", s.result("ZD") == user_dir, s.result("ZD"))
check("an ordinary command sees the user's ZDOTDIR, in the shell and in its environment", s.result("ENVZD") == user_dir and s.result("CMDZD") == user_dir, (s.result("ENVZD"), s.result("CMDZD")))
# `vim $ZDOTDIR/.zshrc`, `source $ZDOTDIR/.zshrc` and `cd $ZDOTDIR` expand
# $ZDOTDIR after preexec ran, so they must find the user's directory.
s.run('print -r -- "RESULT:WRAPPED=$(grep -c terax-shell-integration $ZDOTDIR/.zshrc):"')
check("`$ZDOTDIR/.zshrc` typed by the user is their file, not the wrapper", s.result("WRAPPED") == "0", s.result("WRAPPED"))
s.run('cd $ZDOTDIR; print -r -- "RESULT:PWD=$PWD:"')
check("`cd $ZDOTDIR` goes to the user's directory", (s.result("PWD") or "").endswith(".config/zsh"), s.result("PWD"))
check("history is not kept in the integration directory", (s.result("HIST") or "").startswith(s.home) or s.result("HIST") in (None, "none"), s.result("HIST"))
check("the integration still reports prompts", s.marks().count("133:B") >= 2)
check("the user's ZDOTDIR travels to child shells", s.result("USERVAR") == user_dir, s.result("USERVAR"))
s.close()

# The user sets ZDOTDIR from ~/.zshenv. zsh would continue with their files and
# skip ours if that value were left in place.
s = Session(
    {
        ".zshenv": 'export ZDOTDIR="@HOME@/.config/zsh"\n',
        ".config/zsh/.zshrc": "PS1='PROMPT> '\nA_LOADED=from-user-rc\n" + hook,
    }
)
s.run(probe)
check("a ZDOTDIR set by .zshenv still loads the user's .zshrc", s.result("LOADED") == "from-user-rc", s.result("LOADED"))
check("a ZDOTDIR set by .zshenv does not skip the integration", s.marks().count("133:B") >= 2, s.marks())
check("that ZDOTDIR is what the prompt sees", s.result("ZD") == os.path.join(s.home, ".config/zsh"), s.result("ZD"))
s.close()

# A login profile may select the directory for the subsequent rc and login files.
for profile, initial in ((".zprofile", None), (".config/first/.zprofile", "@HOME@/.config/first")):
    s = Session({
        profile: 'export ZDOTDIR="@HOME@/.config/second"\n',
        ".config/second/.zshrc": "PS1='PROMPT> '\nA_LOADED=profile-rc\n" + hook,
        ".config/second/.zlogin": "LOGIN_LOADED=yes\n",
    }, env={"CODR_USER_ZDOTDIR": initial} if initial else None)
    s.run(probe + '; print -r -- "RESULT:LOGIN=$LOGIN_LOADED:"')
    check("a profile-selected ZDOTDIR loads its rc", s.result("LOADED") == "profile-rc", s.result("LOADED"))
    check("a profile-selected ZDOTDIR loads its login", s.result("LOGIN") == "yes", s.result("LOGIN"))
    check("profile-selected ZDOTDIR reaches hooks", s.result("ZD") == os.path.join(s.home, ".config/second"), s.result("ZD"))
    check("profile-selected ZDOTDIR keeps integration", s.marks().count("133:B") >= 2)
    s.close()

# No ZDOTDIR at all: the prompt must not see one, a running command does.
s = Session({".zshrc": "PS1='PROMPT> '\n" + hook})
s.run(probe)
check("without a user ZDOTDIR the prompt sees none", s.result("ZD") == "unset", s.result("ZD"))
check("without a user ZDOTDIR an ordinary command has none", s.result("ENVZD") == "" and s.result("CMDZD") == "unset", (s.result("ENVZD"), s.result("CMDZD")))
check("without a user ZDOTDIR no user variable is exported", s.result("USERVAR") == "unset", s.result("USERVAR"))
s.close()

# exec zsh, a nested zsh and zsh -l regain the integration, and read the user's
# files exactly once per shell.
for label, user_zdotdir in (("with a user ZDOTDIR", True), ("without a user ZDOTDIR", False)):
    rc = "PS1='PROMPT> '\nprint start >> \"$HOME/rc.log\"\n" + hook
    files = {".zshenv": "print env >> \"$HOME/env.log\"\n"}
    env = None
    if user_zdotdir:
        files = {".config/zsh/.zshrc": rc, ".config/zsh/.zshenv": files[".zshenv"]}
        env = {"CODR_USER_ZDOTDIR": "@HOME@/.config/zsh"}
    else:
        files[".zshrc"] = rc
    s = Session(files, env=env)
    wanted = os.path.join(s.home, ".config/zsh") if user_zdotdir else "unset"
    for command in ("exec zsh -l", "zsh", "zsh -l", "exec zsh"):
        before = s.prompts()
        ok = s.run(command)
        s.run(probe)
        check(f"{label}: `{command}` gets a prompt", ok and s.prompts() > before)
        check(f"{label}: `{command}` is integrated again", s.marks()[-12:].count("133:B") >= 1 and "133:A" in s.marks()[-12:], s.marks()[-12:])
        check(f"{label}: `{command}` sees the user's ZDOTDIR at its prompt", s.result("ZD") == wanted, s.result("ZD"))
        if command.startswith("zsh"):
            s.run("exit")
    shells = open(os.path.join(s.home, "rc.log")).read().count("start") if os.path.exists(os.path.join(s.home, "rc.log")) else 0
    envs = open(os.path.join(s.home, "env.log")).read().count("env") if os.path.exists(os.path.join(s.home, "env.log")) else 0
    check(f"{label}: the user's .zshrc ran once per shell (first, exec, 2 nested, exec)", shells == 5, shells)
    check(f"{label}: the user's .zshenv ran once per shell", envs == 5, envs)
    s.close()

# Only a command line that starts a zsh gets Terax's directory exported; a zsh
# started that way reports the ZDOTDIR it was given, the other lines report what
# an ordinary command sees.
READ = "$(command env | sed -n 's/^ZDOTDIR=//p')"
for label, user_zdotdir in (("with a user ZDOTDIR", True), ("without a user ZDOTDIR", False)):
    rc = "PS1='PROMPT> '\nalias zz=zsh\n" + hook
    if user_zdotdir:
        s = Session({".config/zsh/.zshrc": rc}, env={"CODR_USER_ZDOTDIR": "@HOME@/.config/zsh"})
        ordinary = os.path.join(s.home, ".config/zsh")
    else:
        s = Session({".zshrc": rc})
        ordinary = ""
    # An interactive child that is given Terax's directory loads the integration,
    # which defines _terax_precmd; one that is not reads the user's files.
    def child(n):
        return "-ic 'print -r -- \"RESULT:S%d=${+functions[_terax_precmd]}:\"'" % n

    starts = {
        "zsh": f"zsh {child(1)}",
        "env FOO=1 zsh": f"env FOO=1 zsh {child(2)}",
        "FOO=1 zsh": f"FOO=1 zsh {child(3)}",
        "command zsh": f"command zsh {child(4)}",
        "list `echo hi; zsh`": f"echo hi; zsh {child(5)}",
        "list `zsh; ls`": f"zsh {child(6)}; ls >/dev/null",
        "pipeline `true | zsh`": f"true | zsh {child(7)}",
        "absolute path": f"{shlex.quote(ZSH)} {child(8)}",
        "$SHELL": f"$SHELL {child(9)}",
        "an alias for zsh": f"zz {child(10)}",
        "exec -l zsh": f"(exec -l zsh {child(11)})",
        "exec -a NAME zsh": f"(exec -a myzsh zsh {child(12)})",
        "/usr/bin/env zsh": f"/usr/bin/env zsh {child(13)}",
        "time zsh": f"time zsh {child(14)}",
    }
    for index, (name, line) in enumerate(starts.items(), start=1):
        s.run(line)
        got = s.result(f"S{index}")
        check(f"{label}: `{name}` is given the integration directory", got == "1", got)
    plain = {
        "echo zsh": f'echo zsh; print -r -- "RESULT:N1={READ}:"',
        "print zsh": f'print zsh | cat; print -r -- "RESULT:N2={READ}:"',
        "grep zsh": f'grep -c zsh /dev/null; print -r -- "RESULT:N3={READ}:"',
        "a path argument": f'ls /bin/zsh >/dev/null; print -r -- "RESULT:N4={READ}:"',
        "a zsh word in a string": f'print -r -- "run zsh later"; print -r -- "RESULT:N5={READ}:"',
    }
    for index, (name, line) in enumerate(plain.items(), start=1):
        s.run(line)
        got = s.result(f"N{index}")
        check(f"{label}: `{name}` leaves the user's ZDOTDIR alone", got == ordinary, got)

    # A script or `zsh -c` reads nothing but .zshenv, so it must not keep
    # Terax's directory for its whole run.
    with open(os.path.join(s.home, "probe.zsh"), "w") as handle:
        handle.write('print -r -- "RESULT:SCRIPT=${ZDOTDIR-unset}:"\n')
    s.run("zsh $HOME/probe.zsh")
    check(f"{label}: a script run by zsh sees the user's ZDOTDIR", s.result("SCRIPT") == (ordinary or "unset"), s.result("SCRIPT"))
    s.run("zsh -c 'print -r -- \"RESULT:DASHC=${ZDOTDIR-unset}:\"'")
    check(f"{label}: `zsh -c` sees the user's ZDOTDIR", s.result("DASHC") == (ordinary or "unset"), s.result("DASHC"))

    # The matcher on its own, including the forms that replace the shell, which a
    # pty test cannot observe without losing the session.
    yes = [
        "zsh", "exec zsh", "exec -l zsh", "exec -a NAME zsh", "exec -c zsh", "/usr/bin/env zsh",
        "env zsh", "env -i FOO=1 zsh", "time zsh", "time -p zsh", "coproc zsh", "command -p zsh",
        "sudo -u me zsh", "FOO=1 zsh -l", "echo hi && zsh", "ls | zsh", "(exec zsh)", "{ zsh; }",
        "if true; then zsh; fi", "nohup zsh", "$SHELL -l", "/opt/homebrew/bin/zsh", "sudo -s", "su",
    ]
    no = [
        "echo zsh", "vim $ZDOTDIR/.zshrc", "cat zsh.log", "grep zsh x", 'echo "zsh"', "ls /bin/zsh",
        "exec bash", "env FOO=zsh bash", "time ls", "printf %s zsh", "zshrc", "bash -c zsh", "",
    ]
    table = "typeset -a Y N; Y=(" + " ".join("'" + item + "'" for item in yes) + "); "
    table += "N=(" + " ".join("'" + item + "'" for item in no) + "); "
    table += 'n=0; for l in "${Y[@]}"; do (( n++ )); _terax_starts_zsh "$l"; print -r -- "YES$n=$?"; done; '
    table += 'n=0; for l in "${N[@]}"; do (( n++ )); _terax_starts_zsh "$l"; print -r -- "NO$n=$?"; done'
    s.run(table)
    text = s.out.decode("utf-8", "replace")
    said_yes = {int(n): code for n, code in re.findall(r"\bYES(\d+)=(\d)", text)}
    said_no = {int(n): code for n, code in re.findall(r"\bNO(\d+)=(\d)", text)}
    wrong = [yes[n - 1] for n in range(1, len(yes) + 1) if said_yes.get(n) != "0"]
    wrong += [no[n - 1] for n in range(1, len(no) + 1) if said_no.get(n) != "1"]
    check(f"{label}: the matcher agrees on all {len(yes) + len(no)} lines", not wrong, wrong)

    # The check runs before every command; a pasted 200 KB script must cost
    # nothing noticeable.
    # The best of several samples: one scheduler stall on a shared runner must
    # not fail a check that guards a 263 ms regression.
    s.run('zmodload zsh/datetime; for shape in a b c; do case $shape in a) big=${(pl:200000::echo zsh; :)};; b) big=${(pl:200000::lorem ipsum :)};; c) big=${(pl:200000::ls\n zsh:)};; esac; best=1e9; for try in 1 2 3 4 5 6 7 8; do t0=$EPOCHREALTIME; _terax_starts_zsh "$big"; t1=$EPOCHREALTIME; took=$(( (t1 - t0) * 1000 )); (( took < best )) && best=$took; done; print -r -- "RESULT:PERF$shape=$best:"; done')
    for shape in "a", "b", "c":
        value = s.result(f"PERF{shape}")
        took = f"{float(value):.3f} ms" if value is not None else "?"
        # About 0.5 ms here, almost all of it copying the argument; the best of
        # eight samples under 2 ms is far from the 263 ms an unbounded parse of
        # 60 KB cost, and no longer depends on a single scheduler hiccup.
        check(f"{label}: a 200 KB command line ({shape}) costs next to nothing ({took})", value is not None and float(value) < 2.0, value)
    s.close()

# The implicit end of a command: exec zsh sends C and then the new shell's first
# precmd, which reports D for the command that no longer exists.
s = Session({".zshrc": "PS1='PROMPT> '\n"})
s.run("exec zsh -l")
marks = s.marks()
check("exec zsh reports C then a fresh D, A, B", "133:C;exec zsh -l" in marks and marks[marks.index("133:C;exec zsh -l") :].count("133:A") >= 1, marks)
s.close()

# The user's .zlogin is read from their own directory.
s = Session(
    {".zshrc": "PS1='PROMPT> '\n", ".zlogin": "A_LOADED=from-zlogin\n"},
)
s.run(probe)
check("the user's .zlogin runs", s.result("LOADED") == "from-zlogin", s.result("LOADED"))
s.close()

# Space isolation: post-rc shim PATH precedence, ambient provider key scrubbing,
# .zlogin enforcement, nested subshells, override preservation, and intact HOME/XDG.
def write_exec(path, body):
    with open(path, "w") as handle:
        handle.write(body)
    os.chmod(path, 0o755)

with tempfile.TemporaryDirectory() as space_tmp:
    shim_dir = os.path.join(space_tmp, "spaces", "sp-1", "bin")
    ctrl_dir = os.path.join(space_tmp, "ctrl", "bin")
    claude_dir = os.path.join(space_tmp, "spaces", "sp-1", "claude")
    opc_cfg = os.path.join(space_tmp, "spaces", "sp-1", "opencode", "config")
    opc_data = os.path.join(space_tmp, "spaces", "sp-1", "opencode", "data")
    opc_state = os.path.join(space_tmp, "spaces", "sp-1", "opencode", "state")
    opc_cache = os.path.join(space_tmp, "spaces", "sp-1", "opencode", "cache")
    xdg_cfg = os.path.join(space_tmp, "xdg", "config")
    xdg_data = os.path.join(space_tmp, "xdg", "data")
    xdg_state = os.path.join(space_tmp, "xdg", "state")
    xdg_cache = os.path.join(space_tmp, "xdg", "cache")
    for directory in (shim_dir, ctrl_dir, claude_dir, opc_cfg, opc_data, opc_state, opc_cache, xdg_cfg, xdg_data, xdg_state, xdg_cache):
        os.makedirs(directory, exist_ok=True)
    write_exec(
        os.path.join(shim_dir, "opencode"),
        f"#!/bin/sh\n"
        f"set -eu\n"
        f"SHIM_DIR='{shim_dir}'\n"
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
        f"export XDG_DATA_HOME='{opc_data}'\n"
        f"export XDG_STATE_HOME='{opc_state}'\n"
        f"export XDG_CACHE_HOME='{opc_cache}'\n"
        f"export OPENCODE_CONFIG_DIR='{opc_cfg}'\n"
        f"exec \"$real_opencode\" --standalone \"$@\"\n",
    )
    os.chmod(os.path.join(shim_dir, "opencode"), 0o700)
    write_exec(os.path.join(ctrl_dir, "terax"), "#!/bin/sh\necho CTRL_TERAX\n")
    blocked_agents = ("agy", "codex", "gemini", "grok", "antigravity")
    for agent in blocked_agents:
        write_exec(
            os.path.join(shim_dir, agent),
            f"#!/bin/sh\nprintf '%s\\n' 'codr: Account isolation is unsupported for {agent} in isolated Spaces; refusing host fallback.' >&2\nexit 1\n",
        )

    rc_setup = (
        'mkdir -p "$HOME/.local/bin" "$HOME/.opencode/bin"\n'
        'printf "#!/bin/sh\\nprintf \\"RESULT:OC_ARGS=%%s:\\\\nRESULT:OC_DATA=%%s:\\\\nRESULT:OC_STATE=%%s:\\\\nRESULT:OC_CACHE=%%s:\\\\nRESULT:OC_CFG=%%s:\\\\n\\" \\"\\$*\\" \\"\\${XDG_DATA_HOME-UNSET}\\" \\"\\${XDG_STATE_HOME-UNSET}\\" \\"\\${XDG_CACHE_HOME-UNSET}\\" \\"\\${OPENCODE_CONFIG_DIR-UNSET}\\"\\n" > "$HOME/.opencode/bin/opencode"\n'
        'printf "#!/bin/sh\\necho HOST_TERAX\\n" > "$HOME/.local/bin/terax"\n'
        'chmod 755 "$HOME/.opencode/bin/opencode" "$HOME/.local/bin/terax"\n'
        'for b in agy codex gemini grok antigravity; do\n'
        '  printf "#!/bin/sh\\necho HOST_$(printf %s "$b" | tr a-z A-Z)\\n" > "$HOME/.local/bin/$b"\n'
        '  chmod 755 "$HOME/.local/bin/$b"\n'
        'done\n'
    )
    isolated_files = {
        ".zshenv": rc_setup + 'export PATH="$HOME/.local/bin:$PATH"\nexport OPENAI_API_KEY="sk-openai-zshenv-leak"\n',
        ".zprofile": 'export PATH="$HOME/.local/bin:$PATH"\n',
        ".zshrc": (
            "PS1='PROMPT> '\n"
            "setopt ksh_arrays no_unset\n"
            'export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"\n'
            'export ANTHROPIC_API_KEY="sk-ant-zshrc-leak"\n'
            'export OPENAI_API_KEY="sk-openai-zshrc-leak"\n'
            'export OPENCODE_API_KEY="sk-opencode-zshrc-leak"\n'
            'export GEMINI_API_KEY="AIzaZshrcLeak123"\n'
            'export OPENCODE_CONFIG_DIR="$HOME/.config/opencode-zshrc-override"\n'
        ),
        ".zlogin": (
            'export PATH="$HOME/.opencode/bin:$PATH"\n'
            'export GEMINI_API_KEY="AIzaZloginLeak999"\n'
            'export ANTHROPIC_API_KEY="sk-ant-zlogin-leak"\n'
            'export OPENCODE_CONFIG_DIR="$HOME/.config/opencode-zlogin-override"\n'
        ),
    }
    base_env = {
        "PATH": f"{shim_dir}:{ctrl_dir}:{os.environ.get('PATH', '/usr/bin:/bin')}",
        "CODR_SPACE_SHIM_DIR": shim_dir,
        "CODR_CONTROL_BIN_DIR": ctrl_dir,
        "CLAUDE_CONFIG_DIR": claude_dir,
        "XDG_CONFIG_HOME": xdg_cfg,
        "XDG_DATA_HOME": xdg_data,
        "XDG_STATE_HOME": xdg_state,
        "XDG_CACHE_HOME": xdg_cache,
    }

    s = Session(isolated_files, env=base_env)
    s.run(
        'print -r -- "RESULT:ISO_OC=$(whence -p opencode):" '
        '"RESULT:ISO_TX=$(whence -p terax):" '
        '"RESULT:ISO_ANT=${ANTHROPIC_API_KEY-UNSET}:" '
        '"RESULT:ISO_OAI=${OPENAI_API_KEY-UNSET}:" '
        '"RESULT:ISO_OPC=${OPENCODE_API_KEY-UNSET}:" '
        '"RESULT:ISO_GEM=${GEMINI_API_KEY-UNSET}:" '
        '"RESULT:ISO_HOME=$HOME:" '
        '"RESULT:ISO_XCFG=$XDG_CONFIG_HOME:" '
        '"RESULT:ISO_XDATA=$XDG_DATA_HOME:" '
        '"RESULT:ISO_XSTATE=$XDG_STATE_HOME:" '
        '"RESULT:ISO_XCACHE=$XDG_CACHE_HOME:" '
        '"RESULT:ISO_OPCCFG=${OPENCODE_CONFIG_DIR-UNSET}:" '
        '"RESULT:ISO_CLAUDE=${CLAUDE_CONFIG_DIR-UNSET}:"'
    )
    check("zsh isolated: opencode resolves to Space shim ahead of dotfiles/.zlogin", s.result("ISO_OC") == os.path.join(shim_dir, "opencode"), s.result("ISO_OC"))
    check("zsh isolated: control terax stays ahead of ~/.local/bin", s.result("ISO_TX") == os.path.join(ctrl_dir, "terax"), s.result("ISO_TX"))
    check("zsh isolated: ANTHROPIC_API_KEY is scrubbed after .zshrc/.zlogin", s.result("ISO_ANT") == "UNSET", s.result("ISO_ANT"))
    check("zsh isolated: OPENAI_API_KEY is scrubbed", s.result("ISO_OAI") == "UNSET", s.result("ISO_OAI"))
    check("zsh isolated: OPENCODE_API_KEY is scrubbed", s.result("ISO_OPC") == "UNSET", s.result("ISO_OPC"))
    check("zsh isolated: GEMINI_API_KEY is scrubbed after .zlogin", s.result("ISO_GEM") == "UNSET", s.result("ISO_GEM"))
    check("zsh isolated: dotfile OPENCODE_CONFIG_DIR is scrubbed on shell", s.result("ISO_OPCCFG") == "UNSET", s.result("ISO_OPCCFG"))
    check("zsh isolated: host HOME remains unchanged", s.result("ISO_HOME") == s.home, s.result("ISO_HOME"))
    check("zsh isolated: host XDG_CONFIG_HOME remains unchanged", s.result("ISO_XCFG") == xdg_cfg, s.result("ISO_XCFG"))
    check("zsh isolated: host XDG_DATA_HOME/STATE/CACHE remain unchanged", (s.result("ISO_XDATA"), s.result("ISO_XSTATE"), s.result("ISO_XCACHE")) == (xdg_data, xdg_state, xdg_cache))
    check("zsh isolated: CLAUDE_CONFIG_DIR stays scoped to Space", s.result("ISO_CLAUDE") == claude_dir, s.result("ISO_CLAUDE"))

    s.run('opencode run zsh-turn; print -r -- "RESULT:AFTER_XDATA=$XDG_DATA_HOME:" "RESULT:AFTER_OPCCFG=${OPENCODE_CONFIG_DIR-UNSET}:"')
    check("zsh isolated: opencode shim passes --standalone", s.result("OC_ARGS") == "--standalone run zsh-turn", s.result("OC_ARGS"))
    check("zsh isolated: opencode shim scopes XDG_DATA_HOME/STATE/CACHE and OPENCODE_CONFIG_DIR to Space", (s.result("OC_DATA"), s.result("OC_STATE"), s.result("OC_CACHE"), s.result("OC_CFG")) == (opc_data, opc_state, opc_cache, opc_cfg))
    check("zsh isolated: shell XDG_DATA_HOME and OPENCODE_CONFIG_DIR stay untouched after opencode exits", (s.result("AFTER_XDATA"), s.result("AFTER_OPCCFG")) == (xdg_data, "UNSET"))

    s.run('sh -c \'printf "RESULT:SH_OC=%s:\\nRESULT:SH_OAI=%s:\\nRESULT:SH_CLAUDE=%s:\\n" "$(command -v opencode)" "${OPENAI_API_KEY-UNSET}" "${CLAUDE_CONFIG_DIR-UNSET}"\'')
    check("zsh isolated: child sh inherits Space shim opencode", s.result("SH_OC") == os.path.join(shim_dir, "opencode"), s.result("SH_OC"))
    check("zsh isolated: child sh inherits scrubbed OPENAI_API_KEY", s.result("SH_OAI") == "UNSET", s.result("SH_OAI"))
    check("zsh isolated: child sh inherits CLAUDE_CONFIG_DIR", s.result("SH_CLAUDE") == claude_dir, s.result("SH_CLAUDE"))

    s.run("zsh -l")
    s.run(
        'print -r -- "RESULT:NEST_OC=$(whence -p opencode):" '
        '"RESULT:NEST_ANT=${ANTHROPIC_API_KEY-UNSET}:" '
        '"RESULT:NEST_GEM=${GEMINI_API_KEY-UNSET}:"'
    )
    for agent in blocked_agents:
        s.run(
            f'p=$(whence -p {agent}); err=$({agent} 2>&1 >/dev/null); rc=$?; '
            f'print -r -- "RESULT:NEST_BLK_{agent}=$p|$rc|${{err#*: }}:"'
        )
    s.run("exit")
    check("zsh isolated: nested zsh -l enforces shim opencode after its rc/.zlogin", s.result("NEST_OC") == os.path.join(shim_dir, "opencode"), s.result("NEST_OC"))
    check("zsh isolated: nested zsh -l scrubs ANTHROPIC_API_KEY", s.result("NEST_ANT") == "UNSET", s.result("NEST_ANT"))
    check("zsh isolated: nested zsh -l scrubs GEMINI_API_KEY", s.result("NEST_GEM") == "UNSET", s.result("NEST_GEM"))

    for agent in blocked_agents:
        s.run(
            f'p=$(whence -p {agent}); err=$({agent} 2>&1 >/dev/null); rc=$?; '
            f'print -r -- "RESULT:DIR_BLK_{agent}=$p|$rc|${{err#*: }}:"'
        )
        got = s.result(f"DIR_BLK_{agent}") or ""
        check(
            f"zsh isolated: direct {agent} resolves to Space shim and exits non-zero",
            got.startswith(os.path.join(shim_dir, agent) + "|1|") and "Account isolation is unsupported" in got,
            got,
        )
        nest_got = s.result(f"NEST_BLK_{agent}") or ""
        check(
            f"zsh isolated: nested zsh -l {agent} resolves to Space shim and exits non-zero",
            nest_got.startswith(os.path.join(shim_dir, agent) + "|1|") and "Account isolation is unsupported" in nest_got,
            nest_got,
        )

    s.run(
        'sh -c \'for b in agy codex gemini grok antigravity; do '
        'p=$(command -v "$b"); err=$("$b" 2>&1 >/dev/null); rc=$?; '
        'printf "RESULT:SH_BLK_%s=%s|%s|%s:\\n" "$b" "$p" "$rc" "${err#*: }"; done\''
    )
    s.run(
        'zsh -c \'for b in agy codex gemini grok antigravity; do '
        'p=$(whence -p "$b"); err=$("$b" 2>&1 >/dev/null); rc=$?; '
        'printf "RESULT:ZC_BLK_%s=%s|%s|%s:\\n" "$b" "$p" "$rc" "${err#*: }"; done\''
    )
    s.run(
        'python3 -c \'import shutil, subprocess\n'
        'for b in ("agy", "codex", "gemini", "grok", "antigravity"):\n'
        '    r = subprocess.run([b], capture_output=True, text=True)\n'
        '    err = r.stderr.strip().split(": ", 1)[-1]\n'
        '    print(f"RESULT:PY_BLK_{b}={shutil.which(b)}|{r.returncode}|{err}:")\''
    )
    for agent in blocked_agents:
        sh_got = s.result(f"SH_BLK_{agent}") or ""
        zc_got = s.result(f"ZC_BLK_{agent}") or ""
        py_got = s.result(f"PY_BLK_{agent}") or ""
        expected_prefix = os.path.join(shim_dir, agent) + "|1|"
        check(f"zsh isolated: child sh {agent} resolves to Space shim and blocks", sh_got.startswith(expected_prefix) and "Account isolation is unsupported" in sh_got, sh_got)
        check(f"zsh isolated: child zsh -c {agent} resolves to Space shim and blocks", zc_got.startswith(expected_prefix) and "Account isolation is unsupported" in zc_got, zc_got)
        check(f"zsh isolated: tool subprocess {agent} resolves to Space shim and blocks", py_got.startswith(expected_prefix) and "Account isolation is unsupported" in py_got, py_got)

    stream = s.out.decode("utf-8", "replace")
    for leaked_host in ("HOST_AGY", "HOST_CODEX", "HOST_GEMINI", "HOST_GROK", "HOST_ANTIGRAVITY"):
        check(f"zsh isolated: never delegates to {leaked_host}", leaked_host not in stream)
    for leaked in ("sk-openai-zshenv-leak", "sk-ant-zshrc-leak", "sk-openai-zshrc-leak", "sk-opencode-zshrc-leak", "AIzaZshrcLeak123", "AIzaZloginLeak999", "sk-ant-zlogin-leak"):
        check(f"zsh isolated: no leaked secret {leaked}", leaked not in stream)
    s.close()

    override_files = dict(isolated_files)
    override_files[".zshrc"] = (
        "PS1='PROMPT> '\n"
        'export PATH="$HOME/.opencode/bin:$PATH"\n'
        'export OPENAI_API_KEY="sk-openai-zshrc-leak"\n'
        'export OPENCODE_API_KEY="sk-opencode-zshrc-leak"\n'
        'export GEMINI_API_KEY="AIzaZshrcLeak123"\n'
    )
    override_files[".zlogin"] = 'export PATH="$HOME/.opencode/bin:$PATH"\n'
    override_env = dict(base_env)
    override_env["ANTHROPIC_API_KEY"] = "sk-ant-space-override"
    override_env["CODR_SPACE_ENV_OVERRIDE_KEYS"] = "ANTHROPIC_API_KEY"
    s = Session(override_files, env=override_env)
    s.run(
        'print -r -- "RESULT:OVR_OC=$(whence -p opencode):" '
        '"RESULT:OVR_ANT=${ANTHROPIC_API_KEY-UNSET}:" '
        '"RESULT:OVR_OAI=${OPENAI_API_KEY-UNSET}:" '
        '"RESULT:OVR_OPC=${OPENCODE_API_KEY-UNSET}:" '
        '"RESULT:OVR_GEM=${GEMINI_API_KEY-UNSET}:"'
    )
    check("zsh override: opencode resolves to Space shim", s.result("OVR_OC") == os.path.join(shim_dir, "opencode"), s.result("OVR_OC"))
    check("zsh override: explicit ANTHROPIC_API_KEY override survives", s.result("OVR_ANT") == "sk-ant-space-override", s.result("OVR_ANT"))
    check("zsh override: non-overridden keys scrub cleanly", (s.result("OVR_OAI"), s.result("OVR_OPC"), s.result("OVR_GEM")) == ("UNSET", "UNSET", "UNSET"))
    s.close()

    default_env = {"PATH": f"{ctrl_dir}:{os.environ.get('PATH', '/usr/bin:/bin')}", "CODR_CONTROL_BIN_DIR": ctrl_dir}
    s = Session(isolated_files, env=default_env)
    s.run('print -r -- "RESULT:DEF_OC=$(whence -p opencode):" "RESULT:DEF_ANT=${ANTHROPIC_API_KEY-UNSET}:"')
    check("zsh default: dotfile opencode PATH stays active", s.result("DEF_OC") == os.path.join(s.home, ".opencode", "bin", "opencode"), s.result("DEF_OC"))
    check("zsh default: dotfile ANTHROPIC_API_KEY is left alone", s.result("DEF_ANT") == "sk-ant-zlogin-leak", s.result("DEF_ANT"))
    s.close()

sys.exit(1 if failures else 0)
