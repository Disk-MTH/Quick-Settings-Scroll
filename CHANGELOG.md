# Changelog

All notable changes to this project will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - unreleased

First release. One extension, one job.

### Added
- The Quick Settings menu scrolls when it is taller than the work area.
  Measured in a nested shell at 800x600 with sixteen extra toggles: stock, the
  popup is 782px tall in a 568px work area and everything past the first 568px
  is unreachable; with the extension it is clamped to 556px and the whole grid
  is reachable by scrolling.
- A ceiling on the box pointer, recomputed on every open, on
  `monitors-changed` and on a scale-factor change. It goes there rather than on
  `menu.actor` because `QuickSettingsMenu` replaces that actor with a 0x0
  widget, which is why the one `PanelMenu.Button` already sets constrains
  nothing; and rather than on the scroll view because the box pointer's
  `vfunc_get_preferred_height` ends in `themeNode.adjust_preferred_height`, so
  the figure covers the arrow and the borders with no chrome left to guess at.
- Capture-phase wheel handlers on the box pointer *and* on every submenu
  actor, which together are what actually turn the wheel. A scroll view alone does not: a wheel over a quick toggle
  never reaches it, because the toggles are `St.Button`s and an `St.Button`
  carries a `ClutterClickGesture` as an actor action, which runs in the capture
  phase ahead of every signal. Measured in a nested shell with the pointer on a
  toggle, not one actor from that toggle up to the stage sees the event in
  either phase. Listening on the way down, on an ancestor of everything in the
  popup, gets there first. Sliders and the scroll view inside a submenu's list
  are stepped back for, so the volume and brightness wheels still work --
  measured, the volume moves and the menu does not; and for a scroll view
  inside a submenu's own list, while that list still has somewhere to go. The
  pointer-emulated copy mutter sends beside each notch is dropped, so the menu
  moves one scroll unit per notch rather than two.
- Two listeners rather than one, because an open menu holds a modal grab and
  under a grab mutter starts delivery at the grabbed actor rather than at the
  top of the tree. With no submenu up the grab root is the menu itself; open
  one and the root moves to that submenu, below the box pointer, and every
  listener above it goes silent. Measured in a nested shell with a submenu
  open and 729px of range: with the box-pointer listener alone, three wheel
  notches moved nothing and nothing was logged; with the submenu listener
  added, the same three notches moved the menu 72.1px each. Submenus are
  followed through the overlay's `child-added`, so a toggle another extension
  adds later is covered too.
- A `-st-vfade-offset` at the top and bottom edges of the grid, the only thing
  saying there is more menu past them. No scrollbar is drawn: one inside a
  popup this narrow would have to eat into the grid or sit over a toggle.
- The shell's submenu dim, relayed from the box pointer onto the grid. It dims
  the whole box pointer while a submenu is up, which worked because the overlay
  sat outside it -- the very thing this patch stops being true, so left alone
  the dim covers the submenu too and the whole popup goes dark including the
  part being used. !3272's answer, a counterweight brightness effect on the
  submenu, cannot work: the dim is additive, so cancelling -0.4 needs +0.4 and
  not the +0.2 it uses, and even that would not do it, because each effect
  renders through an 8-bit texture and white submenu text clips to 1.0 on the
  way up to come back down at 0.6. The shell's effect therefore stays on the
  box pointer, under the name `ease_property` resolves, but held disabled,
  while an effect of ours on the grid mirrors its brightness -- the grid being
  the one actor that holds every toggle and no submenu. Driven off brightness
  rather than off `enabled`, whose notifications interleave with the ease in a
  way that leaves the dim off at the moment it is wanted. Measured: no submenu,
  both off; submenu open, ours on at the shell's own -0.402 with no effect on
  the submenu at all; closed, both off again.
  Known difference from stock: the popup's background is painted by the box
  pointer, so the frame around the grid no longer darkens with the toggles.

### Notes
- No shell method is replaced or wrapped. `addItem`, `insertItemBefore`,
  `getFirstItem`, `open` and `close` go on driving the same `_grid` and
  `_overlay` objects, only reparented, so other extensions adding toggles see
  no difference.
- Disabling restores every actor by index rather than by appending, along with
  the overlay's three constraints by identity -- which is what leaves the
  shell's own `updateOffset()` closures driving what they drove before -- its
  four alignment properties, and the box pointer's original style.
- A work area of zero height, which the shell really does hand out before the
  first monitor lands, would make the ceiling negative and collapse the popup
  to its bare 44px arrow. A ceiling at or below zero is not written at all; the
  `monitors-changed` that follows recomputes it.
