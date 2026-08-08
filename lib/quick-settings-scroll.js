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
//     constraints, and nothing clips it. Scroll the grid and an open submenu
//     travels with its toggle straight out of the menu, over the panel and
//     the desktop.
//
// So: a scroll view around the grid, a ceiling in a place that actually bites,
// and the overlay left where it is but clipped and kept in step. No shell
// method is replaced. `addItem`, `insertItemBefore`, `getFirstItem`, `open`
// and `close` go on driving the same `_grid` and `_overlay` objects, so other
// extensions adding toggles see no difference.
//
//   before                             after
//   ------                             -----
//   actor        St.Widget 0x0         actor
//   +- _boxPointer                     +- _boxPointer   <- max-height here
//   |  +- bin                          |  +- bin
//   |     +- box  .quick-settings      |     +- box
//   |        +- _grid                  |        +- scrollView
//   +- _overlay   (submenus)           |           +- viewport
//                                      |              +- _grid
//                                      +- _overlay   (submenus, unmoved)
//
// The overlay does not move, and that is the point: the shell dims the box
// pointer while a submenu is up, so anything inside it recedes and the
// overlay, being outside, keeps its colours. Put the overlay in with the grid
// -- which an earlier version of this did, to make it scroll -- and the dim
// covers the submenu as well. It stays outside and keeps up by other means;
// see _followScroll().

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Slider } from 'resource:///org/gnome/shell/ui/slider.js';

import { debug, debugEnabled, actorName } from './debug.js';

// Logical pixels left between the popup and the edge of the work area, so a
// menu that had to be clamped does not sit flush against the screen.
const EDGE_MARGIN = 12;

// The shell's submenu dim is deliberately not touched anywhere in this file.
// It works by dimming the box pointer, so everything inside recedes and the
// overlay, sitting outside, does not -- which is right only as long as the
// overlay stays outside. An earlier version of this patch moved the overlay in
// with the grid and had to answer for the dim covering the submenu too; every
// answer was a compromise, because the effect is additive through an 8-bit
// texture and cannot be cancelled without clipping white text down to grey.
// So the overlay stays where the shell put it, and the dim is left to do
// exactly what it always did.

export class QuickSettingsScroll {
    constructor() {
        this._menu = null;
        this._scrollView = null;
        this._stack = null;
        this._overlayView = null;
        this._overlayStack = null;
        this._heightBinding = null;
        this._overlayIndex = -1;
        this._overlayConstraints = null;
        this._overlayLayout = null;
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

        // St.Viewport and not a plain St.Widget: a ScrollView only takes a
        // child implementing StScrollable, and Viewport is the one that does
        // it. It scrolls by transform rather than by reallocation, which is
        // what lets the overlay stay outside and still keep up.
        this._stack = new St.Viewport({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });

        box.remove_child(grid);

        // Only the grid moves. The overlay stays exactly where the shell put
        // it -- a sibling of the box pointer, with its three constraints and
        // its alignment untouched -- because that is the one arrangement in
        // which the shell's own dim reads right: it dims the box pointer, so
        // everything inside recedes and the submenu, being outside, does not.
        // Move the overlay in with the grid and the dim covers the submenu
        // too; and it cannot be cancelled afterwards, since the effect is
        // additive through an 8-bit texture and white text clips on the way
        // back up.
        //
        // The submenu still follows the wheel, without being moved. Its own
        // BindConstraint resolves the toggle's position *in overlay
        // coordinates*, and the toggle is inside the scrolled viewport, so
        // the scroll is already in that figure. What the constraint does not
        // do on its own is re-run: scrolling a viewport is a transform, which
        // repaints without relayout. _followScroll() below asks for the one
        // relayout that makes it recompute.
        this._stack = new St.Viewport({ x_expand: true });
        this._stack.add_child(grid);
        this._scrollView.child = this._stack;
        box.insert_child_at_index(this._scrollView, this._gridIndex);

        // A second scroll view, for the overlay alone, and a sibling of the
        // box pointer rather than a descendant. That is the whole reason it
        // exists: outside the box pointer nothing dims it, so the shell's own
        // dim goes on meaning exactly what it always meant.
        //
        // Everything the overlay needs while the grid moves comes from St
        // through it instead of being hand-rolled. It clips, because a scroll
        // view clips to its allocation. It keeps up, because its viewport
        // translates what is inside it. And it fades at whichever edge has
        // content past it, off the same -st-vfade-offset the grid's view
        // reads -- which is the thing that says the menu carries on past the
        // cut, and the reason for going to a second view at all rather than
        // clipping the overlay by hand: StScrollViewFade asserts on being
        // attached to anything that is not an StScrollView.
        this._overlayView = new St.ScrollView({
            style_class: 'qs-scroll-view',
            // Constrained on all four sides below, so neither policy should
            // be allowed to report a minimum of its own.
            hscrollbar_policy: St.PolicyType.EXTERNAL,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
        });

        // The shell's own three constraints, moved off the overlay and onto
        // the view. They already say "at the grid's origin, the grid's width",
        // which is exactly where this view goes, and moving the objects rather
        // than copying their values leaves the shell's updateOffset() closures
        // -- which hold them and go on writing to them -- driving the same
        // thing they always drove.
        //
        // Not a BindConstraint of our own against the scroll view: measured,
        // BindConstraint copies the source's raw position within *its* parent,
        // so binding to a view sitting 19px into `box` lands at 19,19 rather
        // than over the grid.
        this._overlayConstraints = overlay.get_constraints();
        for (const constraint of this._overlayConstraints) {
            overlay.remove_constraint(constraint);
            this._overlayView.add_constraint(constraint);
        }
        // Height is the one thing those three do not carry: the overlay was
        // free to be as tall as its submenu, this view has to stop where the
        // popup does. Sizes bind cleanly, it is only positions that do not.
        this._overlayView.add_constraint(new Clutter.BindConstraint({
            coordinate: Clutter.BindCoordinate.HEIGHT,
            source: this._scrollView,
        }));

        // As tall as the grid, so this view's scroll range is the grid's and
        // one value can drive both. Written as a height rather than bound with
        // a constraint: a scroll view takes its upper bound from the child's
        // *preferred* height, and a constraint only reaches the allocation --
        // measured, bound that way the range came out zero and nothing moved.
        this._overlayStack = new St.Viewport({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });
        // A spacer as tall as the grid, and it is not optional: st_viewport
        // writes its adjustment's bounds from the preferred height of its
        // *children*, so neither setting a height on the viewport nor binding
        // one to it reaches the figure -- measured, both left this view
        // stopping at 240px while the grid ran to 618, and a submenu stopped
        // following part way down. A child of the right height does reach it.
        // The shell reserves room for the overlay in the grid by exactly this
        // trick, with its `placeholder`.
        this._overlaySpacer = new Clutter.Actor();
        this._overlayStack.add_child(this._overlaySpacer);

        this._overlayLayout = {
            x_expand: overlay.x_expand,
            y_expand: overlay.y_expand,
            x_align: overlay.x_align,
            y_align: overlay.y_align,
        };
        // y_expand on and y_align START, counter-intuitively but necessarily.
        // clutter-bin-layout.c reads a child's y_align only when that child
        // needs expand; without it the layout takes its other branch and
        // hardcodes an alignment factor of 0.5, which centres the overlay and
        // drops every submenu half the grid's height too low. Expanding does
        // not stretch it -- that is governed by y_fill, which the same code
        // sets only for FILL -- so START lands it at its natural height on the
        // stack's own origin, which is the grid's origin.
        overlay.set({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.START,
        });

        menu.actor.remove_child(overlay);
        this._overlayStack.add_child(overlay);   // after the spacer: on top
        this._overlayView.child = this._overlayStack;
        menu.actor.add_child(this._overlayView);   // after the box pointer: on top

        this._watchSubmenus(overlay);
        this._followScroll();

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
            // A slider always wants its wheel: turning it there sets a value.
            // A nested scroll view -- a long list inside a submenu -- only
            // wants it while it has somewhere to go. One that has reached its
            // end, or never had a range at all, would otherwise swallow the
            // wheel and leave the menu behind it motionless, which is the
            // same dead feel this extension exists to remove.
            const yields = a instanceof Slider ||
                (a instanceof St.ScrollView &&
                 a.vadjustment.upper > a.vadjustment.page_size);
            if (yields) {
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
            this._watchSubmenu(actor);

        overlay.connectObject(
            'child-added', (_o, actor) => this._watchSubmenu(actor),
            'child-removed', (_o, actor) => this._unwatchSubmenu(actor),
            this);
    }

    _watchSubmenu(actor) {
        // `visible` is the honest signal: QuickToggleMenu shows its actor on
        // open and hides it once the close animation has run, and the grid's
        // own layout decides where to leave a gap off that same property.
        if (debugEnabled) {
            actor.connectObject('notify::visible', () => {
                // Deferred past the open animation, which takes the actor
                // from zero to its full height over ~200ms.
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                    this._debugSnapshot(
                        `submenu ${actor.visible ? 'opened' : 'closed'}`);
                    return GLib.SOURCE_REMOVE;
                });
            }, this);
        }

        // The second place a wheel has to be caught, and the one that took
        // longest to find. An open submenu takes the grab, and under a grab
        // mutter starts delivery at the grabbed actor rather than at the top
        // of the tree -- so every listener above this one, the box pointer's
        // included, stops seeing scroll events the moment a submenu is up.
        // Measured: with a submenu open and 250px of range to move, not one
        // of the four listeners on the way down fired, and the menu sat
        // still. There is no single ancestor that catches both cases, because
        // which actor is the grab root is exactly what changes; so both roots
        // are listened on.
        actor.connectObject(
            'captured-event', (_a, event) => this._onCapturedEvent(event), this);
    }

    _unwatchSubmenu(actor) {
        actor.disconnectObject(this);
    }

    /* ------------------------------ scroll ------------------------------ */

    // One wheel, two views. The overlay's carries the same range as the
    // grid's -- its content is kept at the grid's height -- so copying the
    // value across is the whole of keeping an open submenu over the toggle it
    // belongs to, at any scroll position, with both edges fading on their own.
    _followScroll() {
        const adjustment = this._scrollView.vadjustment;

        // The spacer's height, bound rather than assigned: a binding cannot
        // go stale, and neither notify::height on the grid nor
        // St.Adjustment::changed proved to fire everywhere the figure moves.
        // `upper` is the grid's content height, so this view ends up with the
        // grid's range and one value drives both.
        this._heightBinding = adjustment.bind_property(
            'upper', this._overlaySpacer, 'height',
            GObject.BindingFlags.SYNC_CREATE);

        adjustment.connectObject('notify::value', () => {
            this._overlayView.vadjustment.value = adjustment.value;
        }, this);
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
            this._unwatchSubmenu(actor);
        overlay.disconnectObject(this);
        this._scrollView.vadjustment.disconnectObject(this);
        this._heightBinding?.unbind();

        // The overlay comes out, and its constraints come back to it, before
        // the view they were lent to is destroyed.
        this._overlayStack.remove_child(overlay);
        for (const constraint of this._overlayConstraints ?? []) {
            this._overlayView.remove_constraint(constraint);
            overlay.add_constraint(constraint);
        }
        if (this._overlayLayout)
            overlay.set(this._overlayLayout);
        menu.actor.remove_child(this._overlayView);
        this._overlayView.destroy();   // and the now-empty stack with it
        menu.actor.insert_child_at_index(overlay, this._overlayIndex);

        // The grid is pulled out before the view goes: destroying a
        // ScrollView takes everything still inside it with it, and of the two
        // actors in there only the stack is ours.
        this._stack.remove_child(grid);
        box.remove_child(this._scrollView);
        this._scrollView.destroy();   // and the now-empty stack with it

        box.insert_child_at_index(grid, this._gridIndex);
        menu._boxPointer.style = this._boxPointerStyle;

        this._scrollView = null;
        this._stack = null;
        this._overlayView = null;
        this._overlayStack = null;
        this._heightBinding = null;
        this._themeContext = null;
        this._gridIndex = -1;
        this._boxPointerStyle = null;
        this._menu = null;
    }
}
