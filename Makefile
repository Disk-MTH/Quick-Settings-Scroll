# Quick Settings Scroll: install / package / test.
# Tested on GNOME Shell 49 and 50.

UUID        := quick-settings-scroll@diskmth.fr
USER_EXTDIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
ZIPNAME     := $(UUID).shell-extension.zip
DEBUGLOG    := /tmp/quick-settings-scroll-debug.log

SOURCES     := extension.js $(wildcard lib/*.js)

.PHONY: install uninstall enable disable pack nested debug test-syntax clean help

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
nested: install
	@gnome-extensions list --enabled | grep -qx "$(UUID)" \
	    || printf "Note: not enabled yet, the nested shell will not load it.\n      Run 'make enable' first.\n\n"
	@dbus-run-session -- gnome-shell --devkit

# Same nested shell, with the extension writing down what it sees: what the
# ceiling came out at, whether there was anything to scroll, and what happened
# to every scroll event that reached the popup. Open Quick Settings in the
# nested window, scroll, close the window, and read the file it prints.
#
# The live session cannot be used for this: GNOME Shell caches extension
# modules, so `make install` does not reach a shell that is already running.
# Only a fresh one, nested or after a log out, loads changed code.
debug: install
	@gnome-extensions list --enabled | grep -qx "$(UUID)" \
	    || printf "Note: not enabled yet, the nested shell will not load it.\n      Run 'make enable' first.\n\n"
	@printf "Open Quick Settings in the nested window and try to scroll it.\n"
	@printf "Close the window when done.\n\n"
	@rm -f "$(DEBUGLOG)"
	@dbus-run-session -- env QSS_DEBUG="$(DEBUGLOG)" gnome-shell --devkit || true
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
