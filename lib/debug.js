// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// Off unless QSS_DEBUG names a file to write to, which only `make debug` does.
// It exists because the interesting question -- what happens to a wheel event
// on the way into this menu -- cannot be answered from outside the shell
// process, and synthesised input in a headless session does not answer it
// honestly either. A real finger on a real touchpad does, if something in
// there is writing down what it sees.
//
// The whole file costs one getenv when the extension is not being debugged.

import GLib from 'gi://GLib';

const PATH = GLib.getenv('QSS_DEBUG');

let buffer = '';

/**
 * Append a line to the debug log. A no-op unless QSS_DEBUG is set.
 *
 * @param {...any} parts joined with spaces
 */
export function debug(...parts) {
    if (!PATH)
        return;

    buffer += `${parts.join(' ')}\n`;
    try {
        // Rewritten whole rather than appended: a shell that dies mid-session
        // still leaves a readable file, and the volume here is a few hundred
        // lines at most.
        GLib.file_set_contents(PATH, buffer);
    } catch {
        // A log that cannot be written is not worth an exception in a
        // captured-event handler.
    }
}

export const debugEnabled = !!PATH;

/**
 * Type name of an actor, with the Gjs module noise taken out.
 *
 * @param {Clutter.Actor} actor the actor to name
 * @returns {string} something readable in a log line
 */
export function actorName(actor) {
    try {
        return actor.constructor.$gtype.name.replace(/^Gjs_(ui|status)_\w+_/, '');
    } catch {
        return String(actor);
    }
}
