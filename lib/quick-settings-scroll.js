// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// A Quick Settings menu taller than the screen runs off the bottom edge and
// there is no way to reach what is down there. Three things in GNOME Shell
// 49/50 add up to that:
//
//  1. PanelMenu.Button._onOpenStateChanged does set a max-height on
//     `menu.actor` on every open. But QuickSettingsMenu replaces `actor` with
//     a 0x0 St.Widget that exists only to host the submenu overlay, so that
//     ceiling lands on an actor which constrains nothing.
//  2. There is no scroll view at the top level. PopupSubMenu has one, which
//     is why submenus scroll and the menu holding them does not; PopupMenu
//     itself only does `_boxPointer.bin.set_child(this.box)`.
//  3. The submenus are not inside the popup at all. `_overlay` is a sibling
//     of `_boxPointer` under that 0x0 widget, held over the right row by
//     constraints. Scrolling the grid without it would leave an open submenu
//     painted outside the menu, over the panel and the desktop.
//
// So: a scroll view around the grid *and* the overlay, and a ceiling in a
// place that actually bites. No shell method is replaced. `addItem`,
// `insertItemBefore`, `getFirstItem`, `open` and `close` go on driving the
// same `_grid` and `_overlay` objects, which have only been reparented, so
// other extensions adding toggles see no difference.
//
//   before                             after
//   ------                             -----
//   actor        St.Widget 0x0         actor
//   +- _boxPointer                     +- _boxPointer   <- max-height here
//   |  +- bin                          |  +- bin
//   |     +- box  .quick-settings      |     +- box
//   |        +- _grid                  |        +- scrollView
//   +- _overlay   (submenus)           |           +- stack  BinLayout
//                                      |              +- _grid
//                                      |              +- _overlay
//                                      +- (empty)

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Slider } from 'resource:///org/gnome/shell/ui/slider.js';

import { debug, debugEnabled, actorName } from './debug.js';

// Logical pixels left between the popup and the edge of the work area, so a
// menu that had to be clamped does not sit flush against the screen.
const EDGE_MARGIN = 12;

// The shell dims the whole box pointer while a submenu is up, so the grid
// recedes and the submenu stands out. That worked because the overlay sat
// outside the box pointer; now that it is inside, the dim covers the submenu
// too and the effect reads as a rendering fault. GNOME's own attempt at this
// feature, gnome-shell!3272, restructures the tree exactly the way this file
// does and hits the same wall, so the answer here is theirs: a counterweight
// brightness effect on the submenu, on while it is up.
const DIM_BRIGHTNESS = -0.4;   // as in js/ui/quickSettings.js
// 127.5 is the neutral byte of a Cogl brightness colour, and !3272 winds the
// submenu back up to 255 * (1 + DIM_BRIGHTNESS). Same figure, written as the
// [-1, 1] factor Clutter takes.
const UNDIM = (255 * (1 + DIM_BRIGHTNESS)) / 127.5 - 1;
const UNDIM_NAME = 'qs-scroll-undim';

export class QuickSettingsScroll {
    constructor() {
        this._menu = null;
        this._scrollView = null;
        this._stack = null;
        this._themeContext = null;
        // Everything revert() needs to put the shell back exactly as it was.
        this._gridIndex = -1;
        this._overlayIndex = -1;
        this._overlayConstraints = null;
        this._overlayLayout = null;
        this._boxPointerStyle = null;
    }

    /* ------------------------------- apply ------------------------------ */

    apply() {
        if (this._scrollView)
            return;

        const menu = Main.panel.statusArea.quickSettings?.menu;
        // A shell whose Quick Settings no longer looks like the tree above.
        // Nothing is touched: a half-built patch would be worse than a menu
        // that still cannot scroll.
        if (!menu?.box || !menu._grid || !menu._overlay || !menu._boxPointer) {
            debug('apply: menu does not look like the tree this patches;',
                `box=${!!menu?.box} grid=${!!menu?._grid}`,
                `overlay=${!!menu?._overlay} boxPointer=${!!menu?._boxPointer}`);
            return;
        }

        const { box, _grid: grid, _overlay: overlay } = menu;

        // Recorded before anything moves, so revert() has what it needs even
        // if the surgery below gives up half way.
        this._menu = menu;
        this._boxPointerStyle = menu._boxPointer.style;
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        // Positions, not just parents: another extension may already have put
        // a row of its own in `box`, and putting the grid back on the end of
        // it would silently reorder that extension's menu.
        this._gridIndex = box.get_children().indexOf(grid);
        this._overlayIndex = menu.actor.get_children().indexOf(overlay);

        this._scrollView = new St.ScrollView({
            style_class: 'qs-scroll-view',
            hscrollbar_policy: St.PolicyType.NEVER,
            // EXTERNAL rather than NEVER, and it is not a detail: NEVER makes
            // the view's own minimum height that of its child, which is the
            // very thing the max-height below has to be free to override.
            // EXTERNAL reports a minimum of zero and draws no scrollbar,
            // which is exactly the pair we want -- a bar inside a popup this
            // narrow would have to eat into the grid or overlap a toggle.
            // Neither policy stops the wheel: st_scroll_view_scroll_event
            // never reads it. The fade at the top and bottom edges, from
            // stylesheet.css, is what says there is more menu past them.
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
        });

        // The grid and the overlay have to travel together: the overlay is
        // drawn over the grid and its submenus are placed in grid
        // coordinates. A BinLayout stacks the two at one origin, which is the
        // invariant the shell was getting from the constraints removed just
        // below.
        //
        // St.Viewport and not St.Widget: a ScrollView only takes a child that
        // implements StScrollable, and Viewport is the one that does it while
        // still taking whatever layout manager it is handed. It also scrolls
        // by transform rather than by reallocation, so the grid's own x/y
        // never move and the shell's own updateOffset() handlers stay quiet
        // while the wheel turns.
        this._stack = new St.Viewport({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });

        box.remove_child(grid);
        menu.actor.remove_child(overlay);

        // Kept as objects, not read into values: putting these very
        // constraints back is what leaves the shell's own updateOffset()
        // handlers, which hold them in a closure we cannot reach, driving
        // exactly what they drove before. Meanwhile they go on being written
        // to and nothing reads them, which is the entire cost of leaving
        // those handlers connected.
        this._overlayConstraints = overlay.get_constraints();
        for (const constraint of this._overlayConstraints)
            overlay.remove_constraint(constraint);

        this._overlayLayout = {
            x_expand: overlay.x_expand,
            y_expand: overlay.y_expand,
            x_align: overlay.x_align,
            y_align: overlay.y_align,
        };
        // y_expand has to be on, counter-intuitively, and START is what does
        // the work. clutter-bin-layout.c reads a child's y_align only when
        // that child needs expand; without it the layout takes its other
        // branch and hardcodes an alignment factor of 0.5, which centres the
        // overlay and drops every submenu half the grid's height too low.
        // Expanding does not stretch it: the stretch is governed by y_fill,
        // which that same code sets only when the alignment is FILL. START
        // therefore lands the actor at its natural height on the grid's own
        // origin, which is the invariant the shell's constraints used to
        // hold. Stretching is what must not happen: the grid reserves room
        // for an open submenu through a placeholder bound to this actor's
        // height, so an overlay filled to the stack would feed the grid's
        // height back into it and the layout would never settle.
        overlay.set({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.START,
        });

        this._stack.add_child(grid);
        this._stack.add_child(overlay);   // added second: drawn over the grid
        this._scrollView.child = this._stack;
        box.insert_child_at_index(this._scrollView, this._gridIndex);

        this._watchSubmenus(overlay);

        // What actually turns the wheel, and the reason a scroll view alone
        // is not enough.
        //
        // A wheel over a quick toggle never reaches the view above it. The
        // toggles are St.Buttons, and an St.Button carries a
        // ClutterClickGesture as an actor action; actions run in the capture
        // phase, ahead of every signal, and the event is gone before an
        // ancestor is asked. Measured in a nested shell with the pointer on a
        // toggle: not one actor on the chain from that toggle up to the stage
        // sees the event, in either phase, and the menu does not move. The
        // frame around the grid and the gaps between toggles do scroll, which
        // is what makes the fault look intermittent rather than total.
        //
        // So this listens in the capture phase, on the way down, before any
        // of that can happen, and on the box pointer because it is an
        // ancestor of everything in the popup. What genuinely wants a wheel
        // of its own still gets it: _onCapturedEvent steps back for sliders
        // and for the scroll views inside a submenu's list.
        menu._boxPointer.connectObject(
            'captured-event', (_a, event) => this._onCapturedEvent(event), this);

        this._themeContext.connectObject(
            'notify::scale-factor', () => this._clamp(), this);
        Main.layoutManager.connectObject(
            'monitors-changed', () => this._clamp(), this);
        menu.connectObject('open-state-changed', (_m, isOpen) => {
            // Recomputed per open like the shell does with its own ceiling,
            // and wound back on close so the menu never reopens halfway down
            // where it was left.
            if (isOpen) {
                this._clamp();
                this._debugOpen();
            } else {
                this._scrollView.vadjustment.value = 0;
            }
        }, this);

        this._clamp();
        this._debugSpies();
        debug('apply: patched, scroll view in place');
    }

    // A snapshot of the popup as it stands right now. Taken late -- on a
    // timeout after an open, and again whenever a scroll arrives, which is by
    // definition after the popup has been laid out. An earlier reading is
    // worse than none: before the first allocation every position comes back
    // NaN and both adjustment bounds read zero, which is indistinguishable
    // from a menu that has nothing to scroll.
    _debugSnapshot(why) {
        if (!debugEnabled)
            return;

        const bp = this._menu._boxPointer;
        const adj = this._scrollView.vadjustment;
        const wa = Main.layoutManager.getWorkAreaForMonitor(
            Main.layoutManager.primaryIndex);
        const [, by] = bp.get_transformed_position();
        const [bw, bh] = bp.get_transformed_size();
        const [, gh] = this._menu._grid.get_transformed_size();

        debug(`--- ${why} ---`);
        debug(`  allocated? boxPointer=${bp.has_allocation()}`,
            `view=${this._scrollView.has_allocation()}`);
        debug(`  work area ${wa.width}x${wa.height}@${wa.x},${wa.y}`,
            `scale=${this._themeContext.scale_factor}`);
        debug(`  box pointer ${bw.toFixed(0)}x${bh.toFixed(0)} at y=${by.toFixed(0)}`,
            `style=${JSON.stringify(bp.style)}`);
        debug(`  grid ${gh.toFixed(0)} tall,`,
            `${this._menu._grid.get_children().filter(c => c.visible).length} items visible`);
        debug(`  bottom edge ${(by + bh).toFixed(0)} vs work area bottom`,
            `${wa.y + wa.height} ->`,
            by + bh <= wa.y + wa.height ? 'FITS' : 'STILL OVERFLOWING');
        debug(`  content ${adj.upper.toFixed(0)} in a ${adj.page_size.toFixed(0)} view ->`,
            adj.upper > adj.page_size
                ? `SCROLLABLE by ${(adj.upper - adj.page_size).toFixed(0)}px`
                : 'NOTHING TO SCROLL');
        debug(`  box children: ${this._menu.box.get_children().map(actorName).join(', ')}`);
    }

    _debugOpen() {
        if (!debugEnabled)
            return;

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
            this._debugSnapshot('menu opened');
            return GLib.SOURCE_REMOVE;
        });
    }

    // Where a scroll event actually enters the tree. Not one listener but
    // three, because there is no single answer: an open menu holds a modal
    // grab, and under a grab mutter starts delivery at the grabbed actor
    // rather than at the stage, so a stage-level listener sees nothing at all
    // while the menu is up. Whichever of the three fires says where delivery
    // began, and three silent listeners say the event never came near.
    _debugSpies() {
        if (!debugEnabled)
            return;

        const spy = (actor, label) => {
            if (!actor)
                return;
            actor.connectObject('captured-event', (_a, event) => {
                if (event.type() === Clutter.EventType.SCROLL)
                    this._debugScroll(label, event);
                return Clutter.EVENT_PROPAGATE;
            }, this);
        };

        spy(global.stage, 'stage');
        spy(Main.layoutManager.uiGroup, 'uiGroup');
        spy(this._menu.actor, 'menu.actor');
    }

    _debugScroll(label, event) {
        const [x, y] = event.get_coords();
        const target = global.stage.get_actor_at_pos(
            Clutter.PickMode.REACTIVE, x, y);
        let insidePopup = false;
        for (let a = target; a; a = a.get_parent()) {
            if (a === this._menu?._boxPointer) {
                insidePopup = true;
                break;
            }
        }
        debug(`[${label}] scroll at ${x.toFixed(0)},${y.toFixed(0)}`,
            `on ${actorName(target)}`,
            `dir=${event.get_scroll_direction()}`,
            `emulated=${event.is_pointer_emulated()}`,
            `insidePopup=${insidePopup}`);
    }

    /* ------------------------------- wheel ------------------------------ */

    // Everything the popup is handed, on the way down. Only scrolls are of
    // interest, and only those no one under the pointer has a better claim to.
    _onCapturedEvent(event) {
        if (event.type() !== Clutter.EventType.SCROLL)
            return Clutter.EVENT_PROPAGATE;

        // Whatever sits under the pointer keeps its own wheel if turning it
        // there means something: the volume and brightness sliders, and the
        // scroll view a long submenu list carries. Walked from the target
        // upwards and stopped at our own view, so only what is *nearer* the
        // pointer than the menu-wide scroll wins.
        const [x, y] = event.get_coords();
        const target = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        for (let a = target; a && a !== this._scrollView; a = a.get_parent()) {
            if (a instanceof St.ScrollView || a instanceof Slider) {
                debug(`scroll at ${x.toFixed(0)},${y.toFixed(0)} on ${actorName(target)}:`,
                    `left to ${actorName(a)}`);
                return Clutter.EVENT_PROPAGATE;
            }
        }

        if (!debugEnabled)
            return this._onScroll(event);

        const adj = this._scrollView?.vadjustment;
        const before = adj?.value ?? -1;
        const result = this._onScroll(event);
        debug(`[popup] scroll at ${x.toFixed(0)},${y.toFixed(0)} on ${actorName(target)}:`,
            `dir=${event.get_scroll_direction()}`,
            `emulated=${event.is_pointer_emulated()}`,
            `-> ${before.toFixed(1)} to ${(adj?.value ?? -1).toFixed(1)}`,
            `(range ${(adj?.upper - adj?.page_size).toFixed(0)}px)`);
        // Once per session, and only when a scroll has actually landed: by
        // then the popup is laid out and the figures mean something.
        if (!this._snapshotTaken) {
            this._snapshotTaken = true;
            this._debugSnapshot('popup as it stands at the first scroll');
        }
        return result;
    }

    // Deliberately the same arithmetic st_scroll_view_scroll_event does, by
    // calling the same function on the same adjustment, so that the menu
    // moves by the same amount wherever in it the pointer happens to be.
    _onScroll(event) {
        const adj = this._scrollView?.vadjustment;
        if (!adj)
            return Clutter.EVENT_PROPAGATE;

        // One notch of a wheel arrives twice: once as the discrete event and
        // once as the smooth one mutter synthesises beside it. Acting on both
        // scrolls the menu at double speed, so the emulated one is swallowed
        // and not acted on -- which is what st_scroll_view_scroll_event does
        // with it, two lines into the same function.
        if (event.is_pointer_emulated())
            return Clutter.EVENT_STOP;

        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.SMOOTH: {
            const [, dy] = event.get_scroll_delta();
            adj.adjust_for_scroll_event(dy);
            break;
        }
        case Clutter.ScrollDirection.UP:
            adj.adjust_for_scroll_event(-1);
            break;
        case Clutter.ScrollDirection.DOWN:
            adj.adjust_for_scroll_event(1);
            break;
        default:
            // Horizontal, or a direction St itself would not act on.
            return Clutter.EVENT_PROPAGATE;
        }

        return Clutter.EVENT_STOP;
    }

    /* ------------------------------- undim ------------------------------ */

    // Submenu actors come and go as extensions add and remove toggles, so
    // this follows the overlay's children rather than taking one snapshot.
    _watchSubmenus(overlay) {
        for (const actor of overlay)
            this._addUndim(actor);

        overlay.connectObject(
            'child-added', (_o, actor) => this._addUndim(actor),
            'child-removed', (_o, actor) => this._removeUndim(actor),
            this);
    }

    _addUndim(actor) {
        if (actor.get_effect(UNDIM_NAME))
            return;

        const effect = new Clutter.BrightnessContrastEffect();
        effect.set_brightness(UNDIM);
        effect.enabled = actor.visible;
        actor.add_effect_with_name(UNDIM_NAME, effect);

        // `visible` is the honest signal: QuickToggleMenu shows its actor on
        // open and hides it once the close animation has run, and the grid's
        // own layout decides where to leave a gap off that same property.
        actor.connectObject('notify::visible',
            () => (effect.enabled = actor.visible), this);
    }

    _removeUndim(actor) {
        actor.disconnectObject(this);
        if (actor.get_effect(UNDIM_NAME))
            actor.remove_effect_by_name(UNDIM_NAME);
    }

    /* ------------------------------- clamp ------------------------------ */

    // What actually makes the thing scroll: a scroll view scrolls only when
    // something bounds its height, and nothing here does. The ceiling goes on
    // the BoxPointer rather than on the view because BoxPointer's
    // vfunc_get_preferred_height ends in themeNode.adjust_preferred_height,
    // so the figure it reads covers the whole popup, arrow and borders
    // included, and there is no chrome left over to guess at.
    _clamp() {
        if (!this._scrollView)
            return;

        const workArea = Main.layoutManager.getWorkAreaForMonitor(
            Main.layoutManager.primaryIndex);
        // The work area is in physical pixels and a CSS length is a logical
        // one, so the scale factor has to come back out before this is
        // written into a style.
        const scale = this._themeContext.scale_factor || 1;
        const maxHeight = Math.round(workArea.height / scale) - EDGE_MARGIN;

        // A zero-height work area is not hypothetical: the shell hands one
        // out before the first monitor has landed. The ceiling computed from
        // it comes out negative, and a negative max-height collapses the
        // popup to its bare arrow. Leave the last good one standing; the
        // monitors-changed that follows recomputes it.
        if (maxHeight <= 0) {
            debug(`clamp: work area is ${workArea.width}x${workArea.height},`,
                'ceiling would be <= 0, left alone');
            return;
        }

        this._menu._boxPointer.style = `max-height: ${maxHeight}px;`;
    }

    /* ------------------------------ revert ------------------------------ */

    // The Quick Settings menu outlives the extension: it is the shell's, and
    // it is still there after disable(). So this has to be exact, not merely
    // close, and it runs in reverse order of apply().
    revert() {
        if (!this._scrollView)
            return;

        const menu = this._menu;
        const { box, _grid: grid, _overlay: overlay } = menu;

        menu.disconnectObject(this);
        menu._boxPointer.disconnectObject(this);
        global.stage.disconnectObject(this);
        Main.layoutManager.uiGroup.disconnectObject(this);
        menu.actor.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._themeContext.disconnectObject(this);

        for (const actor of overlay)
            this._removeUndim(actor);
        overlay.disconnectObject(this);

        // Both are pulled out before the view goes: destroying a ScrollView
        // takes everything still inside it with it, and of the three actors
        // in there only the stack is ours.
        this._stack.remove_child(grid);
        this._stack.remove_child(overlay);
        box.remove_child(this._scrollView);
        this._scrollView.destroy();   // and the now-empty stack with it

        // Guarded, not assumed: an apply() that gave up part way through
        // still has to leave disable() able to run to the end.
        if (this._overlayLayout)
            overlay.set(this._overlayLayout);
        for (const constraint of this._overlayConstraints ?? [])
            overlay.add_constraint(constraint);

        box.insert_child_at_index(grid, this._gridIndex);
        menu.actor.insert_child_at_index(overlay, this._overlayIndex);
        menu._boxPointer.style = this._boxPointerStyle;

        this._scrollView = null;
        this._stack = null;
        this._themeContext = null;
        this._gridIndex = -1;
        this._overlayIndex = -1;
        this._overlayConstraints = null;
        this._overlayLayout = null;
        this._boxPointerStyle = null;
        this._menu = null;
    }
}
