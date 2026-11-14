# terax-shell-integration (zshenv)
#
# Terax points ZDOTDIR at its integration directory so zsh reads these wrappers
# first. The user's files are sourced with ZDOTDIR switched back to their own
# directory, so `$ZDOTDIR/conf.d/*.zsh` style loaders resolve where they expect.
# A ZDOTDIR the user's .zshenv sets itself is remembered in CODR_USER_ZDOTDIR,
# otherwise zsh would continue with their .zshrc and skip ours.
#
# Trailing `:` is load-bearing — without it, a missing user .zshenv leaves $?=1,
# which propagates through the rest of init and ultimately into the first
# prompt's `%?` (rendering robbyrussell's `➜` red on a clean shell start).
{
  _terax_zdotdir="$ZDOTDIR"
  _terax_assigned="${CODR_USER_ZDOTDIR:-$HOME}"
  ZDOTDIR="$_terax_assigned"
  [ -f "$_terax_assigned/.zshenv" ] && source "$_terax_assigned/.zshenv"
  if [[ "${ZDOTDIR-}" != "$_terax_assigned" || -n "${CODR_USER_ZDOTDIR-}" ]]; then
    export CODR_USER_ZDOTDIR="${ZDOTDIR:-$HOME}"
  fi
  if [[ ! -o interactive && -n "${CODR_SPACE_SHIM_DIR-}" ]]; then
    () {
      emulate -L zsh
      local keep=",${CODR_SPACE_ENV_OVERRIDE_KEYS-},"
      local key
      for key in ANTHROPIC_API_KEY OPENAI_API_KEY OPENCODE_API_KEY GEMINI_API_KEY; do
        if [[ "$keep" != *,"$key",* ]]; then
          unset "$key" 2>/dev/null || true
        fi
      done
      local shim="$CODR_SPACE_SHIM_DIR"
      local ctrl="${CODR_CONTROL_BIN_DIR-}"
      local -a next=("$shim")
      [[ -n "$ctrl" && "$ctrl" != "$shim" ]] && next+=("$ctrl")
      local entry
      for entry in $path; do
        [[ -z "$entry" || "$entry" = "$shim" ]] && continue
        [[ -n "$ctrl" && "$entry" = "$ctrl" ]] && continue
        next+=("$entry")
      done
      path=("${next[@]}")
      export PATH
    }
  fi
  # An interactive shell goes on to our .zprofile and .zshrc; a script or
  # `zsh -c` reads nothing else, so it keeps the user's own ZDOTDIR.
  if [[ -o interactive ]]; then
    ZDOTDIR="$_terax_zdotdir"
  elif [[ -n "${CODR_USER_ZDOTDIR-}" ]]; then
    ZDOTDIR="$CODR_USER_ZDOTDIR"
  else
    unset ZDOTDIR
  fi
  unset _terax_zdotdir _terax_assigned
}
:
