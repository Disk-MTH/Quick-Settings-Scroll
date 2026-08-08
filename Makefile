# Quick Settings Scroll: install / package / test.
# Tested on GNOME Shell 49 and 50.

UUID        := quick-settings-scroll@diskmth.fr
USER_EXTDIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
ZIPNAME     := $(UUID).shell-extension.zip
DEBUGLOG    := /tmp/quick-settings-scroll-debug.log
# Throwaway config for the nested shell. See the `nested` recipe for why.
NESTED_CFG  := /tmp/quick-settings-scroll-nested-config

SOURCES     := extension.js $(wildcard lib/*.js)

.PHONY: install uninstall enable disable pack nested nested-config debug test-syntax clean help

help:
	@printf "Targets:\n"
	@printf "  install      Install to %s\n" "$(USER_EXTDIR)"
	@printf "  uninstall    Remove the installed extension\n"
	@printf "  enable       Enable the extension via gnome-extensions\n"
	@printf "  disable      Disable the extension via gnome-extensions\n"
	@printf "  nested       Install, then run a nested shell with it enabled\n"
	@printf "  debug        Same, logging what happens to every scroll event\n"
	@printf "  pack         Build a publishable .shell-extension.zip\n"
	@printf "  test-syntax  Parse every JS file\n"
	@printf "  clean        Remove generated files\n"

# Directories are replaced rather than merged, so a file dropped from the
# source tree does not live on in the installed copy.
install:
	@mkdir -p "$(USER_EXTDIR)"
	@cp metadata.json extension.js stylesheet.css "$(USER_EXTDIR)/"
	@rm -rf "$(USER_EXTDIR)/lib"
	@cp -r lib "$(USER_EXTDIR)/"
	@cp LICENSE README.md CHANGELOG.md "$(USER_EXTDIR)/" 2>/dev/null || true
	@printf "Installed to %s\n" "$(USER_EXTDIR)"
	@printf "Restart GNOME Shell (Xorg: Alt+F2 r ; Wayland: log out / log in)\n"
	@printf "or try it without touching this session:  make nested\n"

uninstall:
	@rm -rf "$(USER_EXTDIR)"
	@printf "Removed %s\n" "$(USER_EXTDIR)"

enable:
	@gnome-extensions enable "$(UUID)"

disable:
	@gnome-extensions disable "$(UUID)"

# A throwaway shell in a window of its own, so the patch can be tried on the
# real menu without restarting the session. The nested shell reads the same
# ~/.local/share, so `install` is all it needs; the small screen is the point,
# it makes the menu overflow the way this extension exists to fix.
# The nested shell gets a *copy* of the real dconf, and the override goes in
# front of dbus-run-session rather than inside it. Both matter.
#
# The copy, because a nested session shares the settings database with the
# live one: anything it writes -- an extension of its own being enabled, a
# preference it touches -- lands in the config of the desktop you are sitting
# in. Copying gets the same list of enabled extensions, so the nested menu
# looks like the real one, without writing back to it.
#
# In front, because dconf does not run in this process. It is a D-Bus service
# the bus activates, and an activated service inherits the *bus's*
# environment, not its caller's. Exporting XDG_CONFIG_HOME inside the session
# leaves dconf-service pointed at the real database anyway, which is exactly
# the trap this comment exists to stop anyone falling into twice.
nested: install nested-config
	@env XDG_CONFIG_HOME="$(NESTED_CFG)" dbus-run-session -- gnome-shell --devkit

nested-config:
	@rm -rf "$(NESTED_CFG)"
	@mkdir -p "$(NESTED_CFG)/dconf"
	@cp "$${XDG_CONFIG_HOME:-$$HOME/.config}/dconf/user" "$(NESTED_CFG)/dconf/user" 2>/dev/null \
	    || printf "No dconf database to copy; the nested shell starts with defaults.\n"
	@gnome-extensions list --enabled | grep -qx "$(UUID)" \
	    || printf "Note: not enabled here, so the nested shell will not load it.\n      Run 'make enable' first.\n\n" 

# Same nested shell, with the extension writing down what it sees: what the
# ceiling came out at, whether there was anything to scroll, and what happened
# to every scroll event that reached the popup. Open Quick Settings in the
# nested window, scroll, close the window, and read the file it prints.
#
# The live session cannot be used for this: GNOME Shell caches extension
# modules, so `make install` does not reach a shell that is already running.
# Only a fresh one, nested or after a log out, loads changed code.
debug: install nested-config
	@printf "Open Quick Settings in the nested window and try to scroll it.\n"
	@printf "Open a toggle's submenu and try there too.\n"
	@printf "Close the window when done.\n\n"
	@rm -f "$(DEBUGLOG)"
	@env XDG_CONFIG_HOME="$(NESTED_CFG)" QSS_DEBUG="$(DEBUGLOG)" \
	    dbus-run-session -- gnome-shell --devkit || true
	@printf "\n===== %s =====\n" "$(DEBUGLOG)"
	@cat "$(DEBUGLOG)" 2>/dev/null || printf "(nothing written: the extension never ran)\n"

# Parse only. Running these would need the shell: they import
# resource:///org/gnome/shell/..., which exists nowhere else.
test-syntax:
	@for f in $(SOURCES); do \
	    printf "checking %-32s " "$$f"; \
	    node --check "$$f" >/dev/null 2>&1 && printf "OK\n" \
	        || { printf "FAIL\n"; node --check "$$f"; exit 1; }; \
	done

pack:
	@rm -f "$(ZIPNAME)"
	@zip -qr "$(ZIPNAME)" \
	    metadata.json extension.js stylesheet.css lib \
	    LICENSE README.md CHANGELOG.md
	@printf "Built %s\n" "$(ZIPNAME)"

clean:
	@rm -f "$(ZIPNAME)"
	@rm -rf "$(NESTED_CFG)"
