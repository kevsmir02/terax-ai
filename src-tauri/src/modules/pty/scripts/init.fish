# terax-shell-integration (fish)
# Emits OSC 7 (cwd) + OSC 133 A/B/C/D so the host tracks cwd and prompt
# boundaries without re-parsing the prompt. fish 4.0+ writes its own OSC 133
# A/B (the `mark-prompt` feature); Terax disables it at spawn via
# fish_features=no-mark-prompt so these markers aren't emitted twice.

# Installed into conf.d, which every fish session sources; only Terax-spawned
# shells (CODR_TERMINAL=1) may get their prompt wrapped.
if not set -q CODR_TERMINAL
    exit 0
end
if set -q __CODR_HOOKS_LOADED
    exit 0
end
set -g __CODR_HOOKS_LOADED 1

if set -q CODR_CLI; and test -x "$CODR_CLI"
    function terax
        command "$CODR_CLI" $argv
    end
end

# Terax is a clean terminal; drop fish's default startup greeting. A user who
# sets their own in config.fish (sourced after this) keeps it.
function fish_greeting
end

set -g __TERAX_HOST (uname -n 2>/dev/null; or echo localhost)

# URL-encode a path keeping `/` intact so it stays valid inside file://.
function __terax_urlencode_path
    set -l parts (string split '/' -- $argv[1])
    set -l out
    for p in $parts
        if test -n "$p"
            set out $out (string escape --style=url -- $p)
        else
            set out $out ""
        end
    end
    string join '/' $out
end

function __terax_restore_status
    return $argv[1]
end

function __terax_capture_user_prompt
    if not functions -q fish_prompt
        return
    end
    if functions fish_prompt | string match -q '*__terax_user_prompt*'
        return
    end
    functions -e __terax_user_prompt 2>/dev/null
    functions -c fish_prompt __terax_user_prompt
end

function __terax_prepend_path_dedup --argument-names dir
    test -n "$dir"; or return 0
    set -l next "$dir"
    for entry in $PATH
        if test -n "$entry"; and test "$entry" != "$dir"
            set -a next "$entry"
        end
    end
    set -gx PATH $next
end

function __terax_enforce_space_isolation
    set -g __terax_isolation_enforced 1
    if functions -q __terax_on_first_prompt
        functions -e __terax_on_first_prompt
    end
    set -q CODR_SPACE_SHIM_DIR; and test -n "$CODR_SPACE_SHIM_DIR"; or return 0
    set -l keep
    if set -q CODR_SPACE_ENV_OVERRIDE_KEYS; and test -n "$CODR_SPACE_ENV_OVERRIDE_KEYS"
        set keep (string split ',' -- "$CODR_SPACE_ENV_OVERRIDE_KEYS")
    end
    for key in ANTHROPIC_API_KEY OPENAI_API_KEY OPENCODE_API_KEY GEMINI_API_KEY
        if not contains -- $key $keep
            set -ge $key
            if set -Uq $key
                set -gx $key ""
            end
        end
    end
    if set -q CODR_CONTROL_BIN_DIR; and test -n "$CODR_CONTROL_BIN_DIR"
        __terax_prepend_path_dedup "$CODR_CONTROL_BIN_DIR"
    end
    __terax_prepend_path_dedup "$CODR_SPACE_SHIM_DIR"
end

if not set -q __terax_isolation_enforced
    function __terax_on_first_prompt --on-event fish_prompt
        __terax_enforce_space_isolation
    end
end

# Wrapped so `fish -C __terax_install_prompt` can re-run it AFTER config.fish,
# where a framework prompt (starship etc.) would otherwise override fish_prompt
# and drop our markers.
function __terax_install_prompt
    # ponytail: cover Conda's named wrapper; generalize if another prompt
    # framework preserves Terax indirectly.
    if not set -q CODR_BLOCKS
        and functions -q __fish_prompt_orig
        and functions fish_prompt | string match -q '*__fish_prompt_orig*'
        and functions __fish_prompt_orig | string match -q '*__terax_user_prompt*'
        return
    end
    __terax_capture_user_prompt
    if set -q CODR_BLOCKS
        function fish_right_prompt
        end
        function fish_greeting
        end
    end
    function fish_prompt
        set -l __terax_status $status
        printf '\e]133;D;%d\e\\' $__terax_status
        printf '\e]7;file://%s%s\e\\' "$__TERAX_HOST" (__terax_urlencode_path "$PWD")
        printf '\e]133;A\e\\'
        # Block mode: host renders its own input bar, so suppress the shell prompt
        # (B marker only) and reserve header/gap rows, mirroring zsh.
        if set -q CODR_BLOCKS
            if set -q __terax_block_seen
                printf '\n\n'
            else
                printf '\n'
            end
            printf '\e]133;B\e\\'
            return
        end
        __terax_restore_status $__terax_status
        if functions -q __terax_user_prompt
            __terax_user_prompt
        else
            printf '%s > ' (prompt_pwd)
        end
        printf '\e]133;B\e\\'
    end
end
__terax_install_prompt

function __terax_preexec --on-event fish_preexec
    set -g __terax_block_seen 1
    set -l cmd (string replace -ra '[\x00-\x1f\x7f]' ' ' -- "$argv")
    printf '\e]133;C;%s\e\\' (string sub -l 256 -- "$cmd")
end
