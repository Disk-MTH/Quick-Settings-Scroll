<!-- markdownlint-disable MD033 MD041 -->
[![GNOME Shell 49 | 50](https://img.shields.io/badge/GNOME_Shell-49%20%7C%2050-4A86CF?style=flat-square&logo=gnome&logoColor=white)](https://release.gnome.org/)
[![License: GPL-2.0-or-later](https://img.shields.io/badge/license-GPL--2.0--or--later-3DA639?style=flat-square)](./LICENSE)

# Quick Settings Scroll

**Makes the GNOME Quick Settings menu scroll when it is taller than the
screen.** That is the whole extension. No preferences, no panel item, nothing
to configure: install it and the menu stops running off the bottom edge.

> **Note on development.** This extension was built based on functional specs
> and requirements, with AI assistance used for code generation and iterative
> refinement. The behaviour described below was measured in a nested GNOME
> Shell, but you might still encounter edge cases. Bug reports and
> contributions are very welcome!

## The problem

Add a few extensions with toggles of their own, or run a laptop at a small
resolution or a large text scale, and the Quick Settings menu grows past the
bottom of the screen. What is down there is simply unreachable: the popup does
not scroll, it is just cut off.

Measured in a nested shell at 800x600, with sixteen extra toggles in the menu:

| | popup height | work area | reachable |
|---|---|---|---|
| stock GNOME Shell 50 | 782px | 568px | the top 568px, the rest is off-screen |
| with this extension | 556px | 568px | all of it, by scrolling |

GNOME has an open merge request for this,
[gnome-shell!3272](https://gitlab.gnome.org/GNOME/gnome-shell/-/merge_requests/3272).
It was opened in April 2024 and is still unmerged. This extension exists until
it lands.

## How it works

Three things in GNOME Shell 49/50 add up to the bug, and the fix answers all
three.

1. **The ceiling lands on the wrong actor.** `PanelMenu.Button` does set a
   `max-height` on `menu.actor` every time a panel menu opens. But
   `QuickSettingsMenu` replaces `actor` with a 0x0 `St.Widget` that exists only
   to host the submenu overlay, so that ceiling constrains nothing. The
   extension puts one on the box pointer instead, where `-arrow-rise` and the
   borders are already accounted for.
2. **There is no scroll view at the top level.** `PopupSubMenu` has one, which
   is why submenus scroll and the menu holding them does not. The extension
   adds one around the grid.
3. **The submenus are not inside the popup at all.** `_overlay`, which holds
   every submenu, is a *sibling* of the box pointer, kept over the right row by
   constraints. Scrolling the grid on its own would leave an open Wi-Fi list
   painted over the panel and the desktop. The extension moves the grid and the
   overlay into one `St.Viewport` so they travel together.

```
   before                             after
   ------                             -----
   actor        St.Widget 0x0         actor
   +- _boxPointer                     +- _boxPointer   <- max-height here
   |  +- bin                          |  +- bin
   |     +- box  .quick-settings      |     +- box
   |        +- _grid                  |        +- scrollView
   +- _overlay   (submenus)           |           +- stack  BinLayout
                                      |              +- _grid
                                      |              +- _overlay
                                      +- (empty)
```

Two consequences are worth naming, because they are what makes this work at
all rather than merely look right:

- **A scroll view is not enough to turn a wheel.** A wheel over a quick toggle
  never reaches the view above it: the toggles are `St.Button`s, and an
  `St.Button` carries a `ClutterClickGesture` as an actor action. Actions run
  in the capture phase, ahead of every signal, and the event is gone before an
  ancestor is asked. Measured with the pointer on a toggle, not one actor from
  that toggle up to the stage sees the event in either phase. The frame around
  the grid and the gaps between toggles *do* scroll, which is what makes the
  fault look intermittent rather than total. So the extension listens on the
  box pointer in the capture phase, on the way down, before any of that can
  happen. What genuinely wants a wheel still gets it: the handler steps back
  for sliders and for the scroll view inside a submenu's list.
- **An open submenu has to be un-dimmed.** The shell dims the whole box pointer
  while a submenu is up so the grid recedes behind it. That relied on the
  overlay sitting *outside* the box pointer, which is exactly what stops being
  true here. A counterweight brightness effect goes on each submenu while it is
  visible, the same answer !3272 arrived at.

No shell method is replaced or wrapped. `addItem`, `insertItemBefore`,
`getFirstItem`, `open` and `close` go on driving the same `_grid` and
`_overlay` objects, which have only been reparented, so other extensions
adding toggles see no difference. Disabling the extension puts every actor,
constraint, alignment and style back exactly where it was.

## Install

```bash
git clone https://github.com/Disk-MTH/Quick-Settings-Scroll.git
cd Quick-Settings-Scroll
make install
# Wayland: log out, log back in.
# Xorg:    Alt+F2, type r, Enter.
gnome-extensions enable quick-settings-scroll@diskmth.fr
```

`make nested` tries it in a throwaway shell in its own window, at 800x600 so
the menu actually overflows, without touching the running session. Pack a
release zip with `make pack`.

## Project layout

```
extension.js                  # entry point: apply on enable, revert on disable
lib/quick-settings-scroll.js  # the patch itself
stylesheet.css                # the fade at the scrolled edges
```

## FAQ

### Will it fight with my other extensions?

It should not. It moves shell actors rather than replacing shell methods, so
an extension that adds a toggle keeps calling the same `addItem` on the same
grid. Positions are restored by index, not appended, so an extension that put
a row of its own in the menu gets it back where it was.

### Does anything change when the menu fits on screen?

No. The scroll view draws no scrollbar and the edge fade is only painted on an
edge that has content past it, so a menu that fits looks untouched.

### Why is there no scrollbar?

A bar inside a popup this narrow has to either eat into the grid or sit over a
toggle, and both look wrong. The fade at the top and bottom edges says there is
more menu past them instead.

### When do I uninstall it?

Once GNOME Shell scrolls that menu itself, whether through
[!3272](https://gitlab.gnome.org/GNOME/gnome-shell/-/merge_requests/3272) or
something else. This extension is a stop-gap and has no reason to outlive the
bug.

## License

GPL-2.0-or-later, see [LICENSE](./LICENSE), the same terms GNOME Shell itself
is published under.
