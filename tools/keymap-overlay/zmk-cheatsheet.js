#!/usr/bin/env gjs
/*
 * zmk-cheatsheet — an always-on-top overlay that renders this repo's ZMK
 * keymap as a cheat sheet. Reads config/piantor_pro_bt.keymap directly and
 * reloads whenever the file changes, so the overlay always matches the file.
 */

imports.gi.versions.Gtk = '3.0';
const { Gtk, Gdk, Gio, GLib } = imports.gi;

/* ------------------------------------------------------------------ *
 * Devicetree-ish parsing
 * ------------------------------------------------------------------ */

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/^[ \t]*#[^\n]*/gm, ' ');   // preprocessor lines are not devicetree
}

// Yield every child node of a node body as {header, body}. Properties (which
// end in ';') are skipped here; ownProps() picks those up instead.
function iterNodes(body) {
    const out = [];
    let buf = '';
    let i = 0;
    while (i < body.length) {
        const c = body[i];
        if (c === '{') {
            let depth = 1;
            let j = i + 1;
            while (j < body.length && depth > 0) {
                if (body[j] === '{') depth++;
                else if (body[j] === '}') depth--;
                j++;
            }
            out.push({ header: buf.trim(), body: body.slice(i + 1, j - 1) });
            buf = '';
            i = j;
            const semi = body.indexOf(';', i);
            if (semi !== -1 && body.slice(i, semi).trim() === '') i = semi + 1;
            continue;
        }
        if (c === ';') buf = '';
        else buf += c;
        i++;
    }
    return out;
}

// Properties belonging to this node only — child nodes are skipped wholesale.
function ownProps(body) {
    const props = {};
    let buf = '';
    let i = 0;
    while (i < body.length) {
        const c = body[i];
        if (c === '{') {
            let depth = 1;
            let j = i + 1;
            while (j < body.length && depth > 0) {
                if (body[j] === '{') depth++;
                else if (body[j] === '}') depth--;
                j++;
            }
            buf = '';
            i = j;
            const semi = body.indexOf(';', i);
            if (semi !== -1 && body.slice(i, semi).trim() === '') i = semi + 1;
            continue;
        }
        if (c === ';') {
            const stmt = buf.trim();
            const eq = stmt.indexOf('=');
            if (eq > 0) props[stmt.slice(0, eq).trim()] = stmt.slice(eq + 1).trim();
            else if (stmt) props[stmt] = true;
            buf = '';
        } else {
            buf += c;
        }
        i++;
    }
    return props;
}

// "lt_fast: layer_tap_fast" -> {label: 'lt_fast', name: 'layer_tap_fast'}
function nodeName(header) {
    const parts = header.split(':');
    if (parts.length > 1) return { label: parts[0].trim(), name: parts.slice(1).join(':').trim() };
    return { label: null, name: header.trim() };
}

function unquote(v) {
    if (typeof v !== 'string') return v;
    const m = v.match(/^"(.*)"$/);
    return m ? m[1] : v;
}

// '<&kp A &kp B>' -> ['kp A', 'kp B']
function splitBindings(value) {
    if (!value) return [];
    return value
        .replace(/[<>,]/g, ' ')
        .split('&')
        .map(s => s.trim().replace(/\s+/g, ' '))
        .filter(s => s.length);
}

// '<16 17>' -> [16, 17]
function splitCells(value) {
    if (!value) return [];
    return value.replace(/[<>,]/g, ' ').trim().split(/\s+/).filter(Boolean);
}

function parseKeymap(src) {
    const defines = {};
    // Trailing `// comment` on a #define line is normal and must not stop the
    // match, or every layer reference falls back to NaN and silently degrades.
    for (const m of src.matchAll(/^\s*#define\s+(\w+)\s+(\d+)\s*(?:\/\/.*)?$/gm))
        defines[m[1]] = parseInt(m[2], 10);

    const clean = stripComments(src);
    const roots = iterNodes(clean).filter(n => nodeName(n.header).name === '/');
    const model = {
        defines,
        behaviors: {},
        macros: {},
        layers: [],
        combos: [],
        conditionals: [],
    };
    // This repo splits chosen/behaviors and the keymap into two `/ { }` blocks.
    for (const rootNode of roots) {
        for (const child of iterNodes(rootNode.body)) {
            const { name } = nodeName(child.header);
            switch (name) {
            case 'behaviors':
            for (const b of iterNodes(child.body)) {
                const id = nodeName(b.header);
                const p = ownProps(b.body);
                model.behaviors[id.label || id.name] = {
                    name: id.label || id.name,
                    compatible: unquote(p['compatible'] || ''),
                    inner: splitCells(p['bindings']).map(s => s.replace(/^&/, '')),
                    flavor: unquote(p['flavor'] || ''),
                    tappingTerm: unquote(p['tapping-term-ms'] || '').replace(/[<>]/g, ''),
                    quickTap: unquote(p['quick-tap-ms'] || '').replace(/[<>]/g, ''),
                    priorIdle: unquote(p['require-prior-idle-ms'] || '').replace(/[<>]/g, ''),
                };
            }
            break;
        case 'macros':
            for (const m of iterNodes(child.body)) {
                const id = nodeName(m.header);
                const p = ownProps(m.body);
                model.macros[id.label || id.name] = { name: id.label || id.name, steps: splitBindings(p['bindings']) };
            }
            break;
        case 'combos':
            for (const c of iterNodes(child.body)) {
                const p = ownProps(c.body);
                model.combos.push({
                    name: nodeName(c.header).name,
                    positions: splitCells(p['key-positions']).map(Number),
                    binding: splitBindings(p['bindings'])[0] || '',
                    layers: splitCells(p['layers']),
                    timeout: (p['timeout-ms'] || '').replace(/[<>]/g, ''),
                    priorIdle: (p['require-prior-idle-ms'] || '').replace(/[<>]/g, ''),
                });
            }
            break;
        case 'conditional_layers':
            for (const c of iterNodes(child.body)) {
                const p = ownProps(c.body);
                model.conditionals.push({
                    ifLayers: splitCells(p['if-layers']),
                    thenLayer: splitCells(p['then-layer'])[0] || '',
                });
            }
            break;
        case 'keymap':
            for (const l of iterNodes(child.body)) {
                const p = ownProps(l.body);
                if (unquote(p['status'] || '') === 'reserved') continue;
                const keys = splitBindings(p['bindings']);
                if (!keys.length) continue;
                model.layers.push({
                    node: nodeName(l.header).name,
                    display: unquote(p['display-name'] || '') || nodeName(l.header).name,
                    keys,
                });
            }
            break;
            }
        }
    }
    return model;
}

/* ------------------------------------------------------------------ *
 * Keycodes -> something a human can read at a glance
 * ------------------------------------------------------------------ */

const SYMBOL = {
    AT: '@', HASH: '#', DLLR: '$', PRCNT: '%', CARET: '^', AMPS: '&', STAR: '*', ASTRK: '*',
    LPAR: '(', RPAR: ')', MINUS: '-', UNDER: '_', PLUS: '+', EQUAL: '=',
    LBKT: '[', RBKT: ']', LBRC: '{', RBRC: '}', BSLH: '\\', PIPE: '|',
    SEMI: ';', COLON: ':', SQT: "'", APOS: "'", DQT: '"', GRAVE: '`',
    TILDE: '~', COMMA: ',', DOT: '.', FSLH: '/', QMARK: '?', EXCL: '!',
    LT: '<', GT: '>',
};

const GLYPH = {
    RET: '⏎', ENTER: '⏎', SPACE: '␣', BSPC: '⌫', DEL: '⌦',
    TAB: '⇥', ESC: 'Esc', CAPS: 'Caps', INS: 'Ins', PSCRN: 'PrtSc',
    LEFT: '←', RIGHT: '→', UP: '↑', DOWN: '↓',
    HOME: 'Home', END: 'End', PG_UP: 'PgUp', PG_DN: 'PgDn',
    LSHFT: 'Shift', RSHFT: 'Shift', LSHIFT: 'Shift', RSHIFT: 'Shift',
    LCTRL: 'Ctrl', RCTRL: 'Ctrl', LCTL: 'Ctrl', RCTL: 'Ctrl',
    LALT: 'Alt', RALT: 'AltGr', LGUI: 'Super', RGUI: 'Super',
    K_CUT: 'Cut', K_COPY: 'Copy', K_PASTE: 'Paste',
    C_MUTE: 'Mute', C_VOL_UP: 'Vol+', C_VOL_DN: 'Vol-',
    C_BRI_UP: 'Bri+', C_BRI_DN: 'Bri-',
};

const FULLNAME = {
    RET: 'Enter', SPACE: 'Space', BSPC: 'Backspace', DEL: 'Delete', TAB: 'Tab',
    ESC: 'Escape', PG_UP: 'Page Up', PG_DN: 'Page Down',
    LSHFT: 'Left Shift', LSHIFT: 'Left Shift', RSHFT: 'Right Shift', RSHIFT: 'Right Shift',
    LCTRL: 'Left Ctrl', RCTRL: 'Right Ctrl', LCTL: 'Left Ctrl', LALT: 'Left Alt', LGUI: 'Left Super',
    RALT: 'Right Alt (AltGr)', PSCRN: 'Print Screen',
    K_CUT: 'Cut', K_COPY: 'Copy', K_PASTE: 'Paste',
    C_MUTE: 'Mute', C_VOL_UP: 'Volume up', C_VOL_DN: 'Volume down',
    C_BRI_UP: 'Brightness up', C_BRI_DN: 'Brightness down',
};

// Spoken names for the symbol keys — the glyph alone is not always obvious in
// a 46px box, and this is what the hover line reads out.
const SYMBOL_NAME = {
    AT: 'at', HASH: 'hash', DLLR: 'dollar', PRCNT: 'percent', CARET: 'caret',
    AMPS: 'ampersand', STAR: 'asterisk', ASTRK: 'asterisk', LPAR: 'left paren', RPAR: 'right paren',
    MINUS: 'minus', UNDER: 'underscore', PLUS: 'plus', EQUAL: 'equals',
    LBKT: 'left bracket', RBKT: 'right bracket', LBRC: 'left brace', RBRC: 'right brace',
    BSLH: 'backslash', PIPE: 'pipe', SEMI: 'semicolon', COLON: 'colon',
    SQT: 'apostrophe', APOS: 'apostrophe', DQT: 'double quote', GRAVE: 'backtick',
    TILDE: 'tilde', COMMA: 'comma', DOT: 'period', FSLH: 'slash',
    QMARK: 'question mark', EXCL: 'exclamation', LT: 'less than', GT: 'greater than',
};

const MOD_GLYPH = { LC: '^', RC: '^', LS: '⇧', RS: '⇧', LA: '⌥', RA: '⎇', LG: '❖', RG: '❖' };

// --ascii swaps every non-ASCII glyph for a plain-text stand-in. Minimal WSL
// and container images often ship without a font that covers ⏎ ⌫ ⇧ ⌥, and a
// grid of tofu boxes is worse than no cheat sheet at all.
let ASCII = false;

const GLYPH_ASCII = {
    RET: 'Ent', ENTER: 'Ent', SPACE: 'Spc', BSPC: 'Bksp', DEL: 'Del', TAB: 'Tab',
    LEFT: '<-', RIGHT: '->', UP: 'Up', DOWN: 'Dn',
};
const MOD_GLYPH_ASCII = { LC: 'C-', RC: 'C-', LS: 'S-', RS: 'S-', LA: 'A-', RA: 'AG-', LG: 'G-', RG: 'G-' };

// Glyphs used by the interface itself rather than by a keycode.
const CHROME_UNICODE = { trans: '▽', arrow: '→', dot: '·', dash: '—', mid: ' · ',
                         minus: '−', plus: '+', resize: '⤢', up: '▴', down: '▾', close: '✕', rule: '─' };
const CHROME_ASCII   = { trans: '.', arrow: '->', dot: '*', dash: '--', mid: ' | ',
                         minus: '-', plus: '+', resize: '[]', up: '^', down: 'v', close: 'x', rule: '-' };
function ch(name) {
    return (ASCII ? CHROME_ASCII : CHROME_UNICODE)[name];
}
const MOD_WORD = { LC: 'Ctrl+', RC: 'RCtrl+', LS: 'Shift+', RS: 'RShift+', LA: 'Alt+', RA: 'AltGr+', LG: 'Super+', RG: 'RSuper+' };

const PLAIN_MODS = new Set(['LSHFT', 'RSHFT', 'LSHIFT', 'RSHIFT', 'LCTRL', 'RCTRL',
                            'LCTL', 'RCTL', 'LALT', 'RALT', 'LGUI', 'RGUI']);

function keyGlyph(code) {
    const wrap = code.match(/^([LR][CSAG])\((.*)\)$/);
    if (wrap) return (ASCII ? MOD_GLYPH_ASCII : MOD_GLYPH)[wrap[1]] + keyGlyph(wrap[2]);
    const num = code.match(/^N(\d)$/);
    if (num) return num[1];
    if (SYMBOL[code] !== undefined) return SYMBOL[code];
    if (ASCII && GLYPH_ASCII[code] !== undefined) return GLYPH_ASCII[code];
    if (GLYPH[code] !== undefined) return GLYPH[code];
    return code;
}

function keyWords(code) {
    const wrap = code.match(/^([LR][CSAG])\((.*)\)$/);
    if (wrap) return MOD_WORD[wrap[1]] + keyWords(wrap[2]);
    const num = code.match(/^N(\d)$/);
    if (num) return num[1];
    if (FULLNAME[code] !== undefined) return FULLNAME[code];
    if (SYMBOL[code] !== undefined) return `${SYMBOL[code]}  ${SYMBOL_NAME[code]}`;
    if (GLYPH[code] !== undefined) return GLYPH[code];
    return code;
}

function isModCode(code) {
    return PLAIN_MODS.has(code);
}

/* ------------------------------------------------------------------ *
 * Bindings -> {tap, hold, kind, detail}
 * ------------------------------------------------------------------ */

function layerLabel(model, ref) {
    const idx = model.defines[ref] !== undefined ? model.defines[ref] : parseInt(ref, 10);
    if (!isNaN(idx) && model.layers[idx]) return model.layers[idx].display;
    return ref;
}

function resolve(model, binding) {
    const toks = binding.trim().split(/\s+/);
    const beh = toks[0];
    const args = toks.slice(1);
    const cap = (tap, kind, detail, hold) => ({ tap, hold: hold || '', kind, detail });

    const custom = model.behaviors[beh];
    if (custom && custom.compatible === 'zmk,behavior-hold-tap') {
        const inner = custom.inner.length === 2 ? custom.inner : ['kp', 'kp'];
        const holdSide = resolve(model, `${inner[0]} ${args[0]}`);
        const tapSide = resolve(model, `${inner[1]} ${args[1]}`);
        const timing = [];
        if (custom.flavor) timing.push(custom.flavor);
        if (custom.tappingTerm) timing.push(`${custom.tappingTerm} ms hold`);
        if (custom.priorIdle) timing.push(`disabled within ${custom.priorIdle} ms of a keypress`);
        return {
            tap: tapSide.tap,
            hold: holdSide.tap,
            kind: holdSide.kind === 'layer' ? 'layer' : 'holdtap',
            detail: `tap ${tapSide.detail}${ch('mid')}hold ${holdSide.detail}  ${ch('dash')}  ${beh} (${timing.join(', ')})`,
        };
    }
    if (custom && custom.compatible === 'zmk,behavior-macro') {
        // (macros are collected separately, but be forgiving)
    }
    if (model.macros[beh]) {
        const steps = model.macros[beh].steps.map(s => resolve(model, s).detail).join(' then ');
        // tmux_below -> hold line "tmux", main line "below": the prefix is
        // usually the tool and the suffix is the thing it does.
        const parts = beh.split('_');
        const tap = parts.length > 1 ? parts.slice(1).join(' ') : beh;
        const hold = parts.length > 1 ? parts[0] : '▸';
        return cap(tap, 'macro', `${beh.replace(/_/g, ' ')} macro ${ch('dash')} ${steps}`, hold);
    }

    switch (beh) {
    case 'kp': {
        const code = args[0] || '';
        return cap(keyGlyph(code), isModCode(code) ? 'mod' : 'key', keyWords(code));
    }
    case 'trans':
        return cap(ch('trans'), 'trans', 'transparent, falls through to the layer underneath');
    case 'none':
        return cap('', 'trans', 'no-op');
    case 'mo':
        return cap(layerLabel(model, args[0]), 'layer', `hold for the ${layerLabel(model, args[0])} layer`);
    case 'to':
        return cap(layerLabel(model, args[0]), 'layer', `switch to the ${layerLabel(model, args[0])} layer`);
    case 'tog':
        return cap(layerLabel(model, args[0]), 'layer', `toggle the ${layerLabel(model, args[0])} layer`);
    case 'sl':
        return cap(layerLabel(model, args[0]), 'layer', `sticky ${layerLabel(model, args[0])} layer`);
    case 'sk':
        return cap(keyGlyph(args[0] || ''), 'mod',
            `sticky ${keyWords(args[0] || '')} ${ch('dash')} applies to the next key, and survives a layer change`);
    case 'mmv':
    case 'msc': {
        const dir = (args[0] || '').replace(/^(MOVE|SCRL)_/, '');
        const moving = beh === 'mmv';
        return cap(`${moving ? 'Mv' : 'Scr'}${keyGlyph(dir)}`, 'macro',
            `${moving ? 'move the pointer' : 'scroll'} ${dir.toLowerCase()}`);
    }
    case 'mkp': {
        const map = { LCLK: ['L clk', 'left click'], RCLK: ['R clk', 'right click'],
                      MCLK: ['M clk', 'middle click'], MB4: ['Btn 4', 'mouse button 4'],
                      MB5: ['Btn 5', 'mouse button 5'] };
        const hit = map[args[0]];
        return hit ? cap(hit[0], 'macro', hit[1]) : cap(args.join(' '), 'macro', `mouse ${args.join(' ')}`);
    }
    case 'lt':
        return {
            tap: keyGlyph(args[1] || ''),
            hold: layerLabel(model, args[0]),
            kind: 'layer',
            detail: `tap ${keyWords(args[1] || '')}${ch('mid')}hold for the ${layerLabel(model, args[0])} layer`,
        };
    case 'mt':
        return {
            tap: keyGlyph(args[1] || ''),
            hold: keyGlyph(args[0] || ''),
            kind: 'holdtap',
            detail: `tap ${keyWords(args[1] || '')}${ch('mid')}hold ${keyWords(args[0] || '')}`,
        };
    case 'bt': {
        if (args[0] === 'BT_SEL') return cap(`BT ${args[1]}`, 'sys', `select Bluetooth profile ${args[1]}`);
        if (args[0] === 'BT_CLR') return cap('BT clr', 'sys', 'clear the current Bluetooth profile');
        if (args[0] === 'BT_CLR_ALL') return cap('BT clr*', 'sys', 'clear every Bluetooth profile');
        return cap(args.join(' '), 'sys', `Bluetooth ${args.join(' ')}`);
    }
    case 'out': {
        const map = { OUT_USB: ['USB', 'send output over USB'], OUT_BLE: ['BLE', 'send output over Bluetooth'], OUT_TOG: ['Out ⇄', 'toggle between USB and Bluetooth'] };
        const hit = map[args[0]];
        return hit ? cap(hit[0], 'sys', hit[1]) : cap(args.join(' '), 'sys', args.join(' '));
    }
    case 'sys_reset':
        return cap('Reset', 'sys', 'reset the controller');
    case 'bootloader':
        return cap('Boot', 'sys', 'reboot into the bootloader for flashing');
    case 'studio_unlock':
        return cap('Studio', 'sys', 'unlock ZMK Studio');
    case 'rgb_ug': {
        const map = {
            RGB_TOG: ['RGB', 'toggle RGB underglow'],
            RGB_HUI: ['Hue+', 'increase RGB hue'],
            RGB_HUD: ['Hue-', 'decrease RGB hue'],
            RGB_SAI: ['Sat+', 'increase RGB saturation'],
            RGB_SAD: ['Sat-', 'decrease RGB saturation'],
            RGB_BRI: ['Bri+', 'increase RGB brightness'],
            RGB_BRD: ['Bri-', 'decrease RGB brightness'],
            RGB_EFF: ['Eff+', 'next RGB effect'],
            RGB_EFR: ['Eff-', 'previous RGB effect'],
        };
        const hit = map[args[0]];
        return hit ? cap(hit[0], 'sys', hit[1]) : cap(args.join(' '), 'sys', `RGB ${args.join(' ')}`);
    }
    default:
        return cap(beh.replace(/_/g, ' '), 'key', binding);
    }
}

/* ------------------------------------------------------------------ *
 * Physical layout — Piantor Pro BT: 3x12 keys plus 6 thumbs
 * Stagger from config/piantor_pro_bt.json (y * 16 px at scale 1).
 * ------------------------------------------------------------------ */

const ROWS = 3;
const COLS_PER_HALF = 6;
const COLS = COLS_PER_HALF * 2;
const THUMBS_PER_HALF = 3;
const THUMBS = THUMBS_PER_HALF * 2;
const STAGGER = [16, 16, 4, 0, 4, 6, 6, 4, 0, 4, 16, 16];
const THUMB_STAGGER = [2, 0, 4, 8, 2, 0];

// "left thumb", "home row" ... enough to find the key with your fingers.
function posName(pos) {
    if (pos >= ROWS * COLS) {
        const t = pos - ROWS * COLS;
        return t < THUMBS_PER_HALF ? 'left thumb' : 'right thumb';
    }
    return ['top row', 'home row', 'bottom row'][Math.floor(pos / COLS)];
}

// Walk every layer looking for the key that reaches `target`, so the overlay
// can tell you how to get there rather than just what is on it.
// How a layer behaves when it is the TAP half of a hold-tap, and when it is
// the HOLD half. A key can be both at once - `slt L1 L1` is tog-on-hold and
// sl-on-tap - so the hint names both.
const LAYER_VERB_TAP  = { mo: 'tap-and-hold', to: 'tap to switch', tog: 'tap to lock', sl: 'tap for one key' };
const LAYER_VERB_HOLD = { mo: 'hold', to: 'hold to switch', tog: 'hold to lock', sl: 'hold' };

function accessHint(model, target) {
    if (target === 0) return 'default layer';
    for (const cond of model.conditionals) {
        const then = model.defines[cond.thenLayer] !== undefined
            ? model.defines[cond.thenLayer] : parseInt(cond.thenLayer, 10);
        if (then === target)
            return 'hold ' + cond.ifLayers.map(l => layerLabel(model, l)).join(' + ');
    }
    const hits = ref => {
        if (ref === undefined) return false;
        const idx = model.defines[ref] !== undefined ? model.defines[ref] : parseInt(ref, 10);
        return idx === target;
    };
    for (let li = 0; li < model.layers.length; li++) {
        const keys = model.layers[li].keys;
        for (let pos = 0; pos < keys.length; pos++) {
            const toks = keys[pos].trim().split(/\s+/);
            const custom = model.behaviors[toks[0]];
            const how = [];
            if (LAYER_VERB_TAP[toks[0]] && hits(toks[1])) {
                how.push(toks[0] === 'mo' ? 'hold' : LAYER_VERB_TAP[toks[0]]);
            } else if (toks[0] === 'lt' && hits(toks[1])) {
                how.push('hold');
            } else if (custom && custom.inner.length === 2) {
                // hold binding takes the first arg, tap binding the second
                if (LAYER_VERB_HOLD[custom.inner[0]] && hits(toks[1])) how.push(LAYER_VERB_HOLD[custom.inner[0]]);
                if (LAYER_VERB_TAP[custom.inner[1]] && hits(toks[2])) how.push(LAYER_VERB_TAP[custom.inner[1]]);
            }
            if (!how.length) continue;
            const where = li === 0 ? posName(pos) : `${posName(pos)} on ${model.layers[li].display}`;
            return how.join(ch('mid')) + ch('mid') + where;
        }
    }
    return 'always active';
}

// "on L0" / "on L1, L2, L3, L4" / "on every layer" - a combo scoped with
// `layers` only fires while one of them is the highest active layer.
function comboScope(model, combo) {
    if (!combo.layers || !combo.layers.length) return 'every layer';
    return 'on ' + combo.layers.map(l => layerLabel(model, l)).join(', ');
}

function comboLayerIndex(model, ref) {
    if (model.defines[ref] !== undefined) return model.defines[ref];
    const n = parseInt(ref, 10);
    return isNaN(n) ? -1 : n;
}

function comboLiveOnLayer(model, combo, layerIdx) {
    if (!combo.layers || !combo.layers.length) return true;
    return combo.layers.some(ref => comboLayerIndex(model, ref) === layerIdx);
}

function combosAt(model, layerIdx, pos) {
    return model.combos.filter(c =>
        comboLiveOnLayer(model, c, layerIdx) && c.positions.includes(pos));
}

// Partner names always come from base, so Q+W stays Q+W on L1 (where
// those keys are Esc and @).
function comboPartnerLabel(model, combo, pos) {
    return combo.positions.filter(p => p !== pos)
        .map(p => keyLabelAt(model, 0, p)).join('+');
}

function comboLine(model, combo, pos) {
    const result = resolve(model, combo.binding);
    return `+${comboPartnerLabel(model, combo, pos)} ${result.tap || result.detail}`;
}

function comboDetail(model, combo, pos) {
    const result = resolve(model, combo.binding);
    const partners = combo.positions.filter(p => p !== pos)
        .map(p => keyLabelAt(model, 0, p)).join(' + ');
    const idle = combo.priorIdle ? `, idle ${combo.priorIdle} ms` : '';
    return `combo with ${partners} ${ch('arrow')} ${result.detail} (${combo.timeout || '?'} ms, ${comboScope(model, combo)}${idle})`;
}

function keyLabelAt(model, layerIdx, pos) {
    const layer = model.layers[layerIdx];
    if (!layer || !layer.keys[pos]) return `#${pos}`;
    const r = resolve(model, layer.keys[pos]);
    return r.tap || r.hold || `#${pos}`;
}

/* ------------------------------------------------------------------ *
 * Persisted state
 * ------------------------------------------------------------------ */

const STATE_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'zmk-cheatsheet']);
const STATE_FILE = GLib.build_filenamev([STATE_DIR, 'state.json']);

function loadState() {
    const fallback = { x: -1, y: -1, layer: 0, opacity: 1.0, scale: 1.0, collapsed: false };
    try {
        const [ok, bytes] = GLib.file_get_contents(STATE_FILE);
        if (!ok) return fallback;
        return Object.assign(fallback, JSON.parse(new TextDecoder().decode(bytes)));
    } catch (e) {
        return fallback;
    }
}

function saveState(state) {
    try {
        GLib.mkdir_with_parents(STATE_DIR, 0o755);
        GLib.file_set_contents(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
        // a cheat sheet that can't remember where it sat is still a cheat sheet
    }
}

/* ------------------------------------------------------------------ *
 * Terminal dump (--dump) — same data, no window
 * ------------------------------------------------------------------ */

function dump(model) {
    for (let i = 0; i < model.layers.length; i++) {
        const layer = model.layers[i];
        print(`\n${ch('rule').repeat(2)} ${layer.display}  (layer ${i}) ${ch('rule').repeat(31)}`);
        for (let r = 0; r < ROWS; r++) {
            const cells = [];
            for (let c = 0; c < COLS; c++) {
                const k = resolve(model, layer.keys[r * COLS + c] || 'none');
                const s = k.hold ? `${k.tap}(${k.hold})` : k.tap;
                cells.push(s.padEnd(9).slice(0, 9));
                if (c === COLS_PER_HALF - 1) cells.push('  ');
            }
            print('  ' + cells.join(' '));
        }
        const thumbs = [];
        for (let t = 0; t < THUMBS; t++) {
            const k = resolve(model, layer.keys[ROWS * COLS + t] || 'none');
            thumbs.push((k.hold ? `${k.tap}(${k.hold})` : k.tap).padEnd(9).slice(0, 9));
            if (t === THUMBS_PER_HALF - 1) thumbs.push('  ');
        }
        print('  ' + ' '.repeat(36) + thumbs.join(' '));
    }
    print(`\n${ch('rule').repeat(2)} combos ${ch('rule').repeat(46)}`);
    for (const combo of model.combos) {
        const keys = combo.positions.map(p => keyLabelAt(model, 0, p)).join(' + ');
        print(`  ${keys}  ${ch('arrow')}  ${resolve(model, combo.binding).detail}  (${combo.timeout} ms, ${comboScope(model, combo)})`);
    }
    for (const cond of model.conditionals) {
        const names = cond.ifLayers.map(l => layerLabel(model, l)).join(' + ');
        print(`  hold ${names}  ${ch('arrow')}  ${layerLabel(model, cond.thenLayer)} layer`);
    }
    print('');
}

/* ------------------------------------------------------------------ *
 * Styling
 * ------------------------------------------------------------------ */

const LAYER_ACCENT = ['#7cc2ff', '#a9e34b', '#ffb454', '#ff8fa3', '#c9a0ff', '#5ad1c4', '#f0c674'];

function buildCss(scale) {
    const px = n => Math.round(n * scale);
    const accents = LAYER_ACCENT.map((c, i) => `
        .tab.lay${i}.active { background-color: ${c}; color: #10121a; }
        .tab.lay${i} { color: ${c}; }
        #title.lay${i} { color: ${c}; }
    `).join('\n');
    return `
    window, #shade, #root {
        background-image: none;
        background-color: #10121a;
    }

    #root {
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: ${px(14)}px;
        padding: ${px(9)}px ${px(11)}px ${px(8)}px ${px(11)}px;
    }

    #title { color: #eceef5; font-size: ${px(12)}px; font-weight: bold; }
    #subtitle { color: #666d80; font-size: ${px(10)}px; }

    .tab {
        background-image: none;
        background-color: rgba(255, 255, 255, 0.05);
        border: none;
        box-shadow: none;
        text-shadow: none;
        border-radius: ${px(7)}px;
        padding: ${px(2)}px ${px(10)}px;
        margin: 0 ${px(2)}px;
        font-size: ${px(11)}px;
        font-weight: bold;
        min-height: 0;
    }
    .tab:hover { background-color: rgba(255, 255, 255, 0.12); }

    .iconbtn {
        background-image: none;
        background-color: transparent;
        border: none;
        box-shadow: none;
        text-shadow: none;
        color: #666d80;
        font-size: ${px(12)}px;
        padding: ${px(1)}px ${px(6)}px;
        min-height: 0;
        min-width: 0;
    }
    .iconbtn:hover { color: #eceef5; background-color: rgba(255, 255, 255, 0.09); border-radius: ${px(6)}px; }

    .key {
        background-color: #1b1e28;
        border: 1px solid #2b3040;
        border-radius: ${px(8)}px;
    }
    .key:hover { border-color: #4d566e; background-color: #232735; }
    .key.trans { background-color: #161821; border-color: #2a2e3a; }

    .tap { color: #e6e9f0; font-size: ${px(14)}px; font-weight: bold; }
    .hold { color: #7cc2ff; font-size: ${px(9)}px; }
    .key.trans .tap { color: #3b4152; font-size: ${px(11)}px; }
    .key.mod .tap { color: #98a0b5; font-size: ${px(11)}px; }
    .key.layer .tap { color: #ffb454; font-size: ${px(11)}px; }
    .key.layer .hold { color: #ffb454; }
    .key.macro .tap { color: #a9e34b; font-size: ${px(10)}px; }
    .key.macro .hold { color: #a9e34b; }
    .key.sys .tap { color: #ff8fa3; font-size: ${px(11)}px; }
    .key.has-combo { border-color: #5c4d78; }
    .combo { color: #c9a0ff; font-size: ${px(8)}px; }

    #hover { color: #b9c0d4; font-size: ${px(10)}px; }
    #combos { color: #666d80; font-size: ${px(10)}px; }

    ${accents}
    `;
}

/* ------------------------------------------------------------------ *
 * Environment
 * ------------------------------------------------------------------ */

// GTK will happily run under X11, XWayland or Wayland, but only X11 lets a
// client place its own window and ask to stay above everything else.
function detectEnv() {
    const display = String(Gdk.Display.get_default() || '');
    let wsl = false;
    try {
        const [ok, bytes] = GLib.file_get_contents('/proc/version');
        if (ok) wsl = /microsoft|wsl/i.test(new TextDecoder().decode(bytes));
    } catch (e) {
        // not Linux, or /proc is not mounted: assume not WSL
    }
    return {
        x11: /GdkX11Display/.test(display),
        wayland: /GdkWaylandDisplay/.test(display),
        wsl,
    };
}

/* ------------------------------------------------------------------ *
 * Window
 * ------------------------------------------------------------------ */

const Overlay = class Overlay {
    constructor(path, opts) {
        this.path = path;
        this.opts = opts;
        this.state = loadState();
        if (opts.scale) this.state.scale = opts.scale;
        this.model = null;
        this.cssProvider = new Gtk.CssProvider();
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(), this.cssProvider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        this.env = detectEnv();
        this.win = new Gtk.Window({ title: 'zmk-cheatsheet', type: Gtk.WindowType.TOPLEVEL });
        this.win.set_decorated(false);
        this.win.set_keep_above(true);
        this.win.set_skip_taskbar_hint(true);
        this.win.set_skip_pager_hint(true);
        this.win.set_resizable(false);
        this.win.stick();
        if (!opts.focus) {
            // An overlay that never steals focus: keep typing into your editor.
            this.win.set_accept_focus(false);
            this.win.set_focus_on_map(false);
        }
        this.win.set_app_paintable(true);
        this.win.connect('draw', (w, cr) => {
            const a = w.get_allocation();
            cr.setSourceRGB(0x10 / 255, 0x12 / 255, 0x1a / 255);
            cr.rectangle(0, 0, a.width, a.height);
            cr.fill();
            return false;
        });
        this.win.set_opacity(this.state.opacity);
        this.win.connect('destroy', () => Gtk.main_quit());

        this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
        this.root.set_name('root');
        const drag = new Gtk.EventBox({ visible_window: true });
        drag.set_name('shade');
        drag.add(this.root);
        drag.connect('button-press-event', (_w, ev) => {
            const [, btn] = ev.get_button();
            const [, xr, yr] = ev.get_root_coords();
            if (btn === 1) this.win.begin_move_drag(btn, xr, yr, ev.get_time());
            return true;
        });
        drag.add_events(Gdk.EventMask.SCROLL_MASK);
        drag.connect('scroll-event', (_w, ev) => {
            const [, dir] = ev.get_scroll_direction();
            if (dir === Gdk.ScrollDirection.UP) this.cycleLayer(-1);
            else if (dir === Gdk.ScrollDirection.DOWN) this.cycleLayer(1);
            return true;
        });
        this.win.add(drag);

        if (opts.focus) {
            this.win.add_events(Gdk.EventMask.KEY_PRESS_MASK);
            this.win.connect('key-press-event', (_w, ev) => this.onKey(ev));
        }

        if (!this.env.x11) {
            // Wayland (WSLg included) hands window placement and stacking to
            // the compositor; there is no protocol for a client to demand it.
            printerr('zmk-cheatsheet: not on X11 — "always on top" and the saved '
                + 'window position are up to your compositor. '
                + (this.env.wsl ? 'Under WSLg, pin the window with your window manager, '
                    + 'or use --html for a browser cheat sheet.' : ''));
        }

        this.win.connect('configure-event', () => {
            if (!this.env.x11) return false;
            const [x, y] = this.win.get_position();
            if (x !== this.state.x || y !== this.state.y) {
                this.state.x = x;
                this.state.y = y;
                this.scheduleSave();
            }
            return false;
        });

        this.reload();
        this.watch();
    }

    scheduleSave() {
        if (this._saveId) GLib.source_remove(this._saveId);
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._saveId = 0;
            saveState(this.state);
            return GLib.SOURCE_REMOVE;
        });
    }

    watch() {
        const bump = () => {
            if (this._reloadId) GLib.source_remove(this._reloadId);
            this._reloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this._reloadId = 0;
                this.reload();
                return GLib.SOURCE_REMOVE;
            });
        };
        const file = Gio.File.new_for_path(this.path);
        this.fileMonitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
        this.fileMonitor.connect('changed', bump);
        // Editors that save by writing a temp file and renaming over the
        // original leave the file monitor watching a dead inode, so watch the
        // containing directory as well.
        this.dirMonitor = file.get_parent().monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this.dirMonitor.connect('changed', (_m, changed) => {
            if (changed && changed.get_path() === this.path) bump();
        });
    }

    reload() {
        try {
            const [ok, bytes] = GLib.file_get_contents(this.path);
            if (!ok) return;
            this.model = parseKeymap(new TextDecoder().decode(bytes));
        } catch (e) {
            logError(e, 'could not re-read the keymap');
            return;
        }
        if (this.state.layer >= this.model.layers.length) this.state.layer = 0;
        this.cssProvider.load_from_data(new TextEncoder().encode(buildCss(this.state.scale)));
        this.build();
    }

    build() {
        this.root.get_children().forEach(c => this.root.remove(c));
        const s = this.state.scale;
        const px = n => Math.round(n * s);

        this.root.pack_start(this.buildHeader(px), false, false, 0);
        if (!this.state.collapsed) {
            this.root.pack_start(this.buildBoard(px), false, false, px(8));
            this.root.pack_start(this.buildFooter(px), false, false, 0);
        }
        this.root.show_all();
        this.win.show_all();
        this.win.resize(1, 1);
        // Position only sticks once the window is mapped, and only on X11.
        if (this.env.x11 && this.state.x >= 0) this.win.move(this.state.x, this.state.y);
    }

    buildHeader(px) {
        const bar = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 0 });

        const active = this.model.layers[this.state.layer];
        const titles = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        const title = new Gtk.Label({ label: `${active.display} layer`, xalign: 0 });
        title.set_name('title');
        title.get_style_context().add_class(`lay${this.state.layer % LAYER_ACCENT.length}`);
        title.set_tooltip_text(this.path);
        const sub = new Gtk.Label({ label: accessHint(this.model, this.state.layer), xalign: 0 });
        sub.set_name('subtitle');
        titles.pack_start(title, false, false, 0);
        titles.pack_start(sub, false, false, 0);
        bar.pack_start(titles, false, false, 0);

        const tabs = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 0 });
        tabs.set_halign(Gtk.Align.CENTER);
        this.model.layers.forEach((layer, i) => {
            const btn = new Gtk.Button({ label: layer.display });
            const ctx = btn.get_style_context();
            ctx.add_class('tab');
            ctx.add_class(`lay${i % LAYER_ACCENT.length}`);
            if (i === this.state.layer) ctx.add_class('active');
            btn.connect('clicked', () => this.setLayer(i));
            tabs.pack_start(btn, false, false, 0);
        });
        bar.pack_start(tabs, true, true, px(8));

        const controls = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 0 });
        const icon = (glyph, tip, fn) => {
            const b = new Gtk.Button({ label: glyph, tooltip_text: tip });
            b.get_style_context().add_class('iconbtn');
            b.connect('clicked', fn);
            controls.pack_start(b, false, false, 0);
        };
        icon(ch('minus'), 'More transparent', () => this.bumpOpacity(-0.07));
        icon(ch('plus'), 'More opaque', () => this.bumpOpacity(0.07));
        icon(ch('resize'), 'Cycle size', () => this.cycleScale());
        icon(this.state.collapsed ? ch('down') : ch('up'), 'Collapse to the title bar', () => {
            this.state.collapsed = !this.state.collapsed;
            this.scheduleSave();
            this.build();
        });
        icon(ch('close'), 'Close', () => this.quit());
        bar.pack_end(controls, false, false, 0);

        return bar;
    }

    buildBoard(px) {
        const layer = this.model.layers[this.state.layer];
        // Each half owns its own columns *and* its own thumb cluster, so the
        // thumbs can never drift out of alignment with the keys above them.
        const board = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: px(26) });
        board.set_halign(Gtk.Align.CENTER);

        const halves = [];
        for (let h = 0; h < 2; h++) {
            const half = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: px(6) });
            const cols = new Gtk.Box({ spacing: px(4) });
            const thumbs = new Gtk.Box({ spacing: px(4) });
            thumbs.set_halign(h === 0 ? Gtk.Align.END : Gtk.Align.START);
            half.pack_start(cols, false, false, 0);
            half.pack_start(thumbs, false, false, 0);
            halves.push({ half, cols, thumbs });
            board.pack_start(half, false, false, 0);
        }

        for (let c = 0; c < COLS; c++) {
            const col = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: px(4) });
            col.set_margin_top(px(STAGGER[c]));
            col.set_valign(Gtk.Align.START);
            for (let r = 0; r < ROWS; r++)
                col.pack_start(this.makeKey(layer.keys[r * COLS + c], r * COLS + c, px), false, false, 0);
            halves[c < COLS_PER_HALF ? 0 : 1].cols.pack_start(col, false, false, 0);
        }

        for (let t = 0; t < THUMBS; t++) {
            const key = this.makeKey(layer.keys[ROWS * COLS + t], ROWS * COLS + t, px);
            key.set_margin_top(px(THUMB_STAGGER[t]));
            key.set_valign(Gtk.Align.START);
            halves[t < THUMBS_PER_HALF ? 0 : 1].thumbs.pack_start(key, false, false, 0);
        }

        return board;
    }

    makeKey(binding, pos, px) {
        const info = resolve(this.model, binding || 'none');
        const combos = combosAt(this.model, this.state.layer, pos);
        // The style classes live on the EventBox so that :hover actually fires.
        const ev = new Gtk.EventBox({ visible_window: true });
        const ctx = ev.get_style_context();
        ctx.add_class('key');
        if (info.kind !== 'key' && info.kind !== 'holdtap') ctx.add_class(info.kind);
        if (combos.length) ctx.add_class('has-combo');
        ev.set_size_request(px(46), px(46));
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });

        const hold = new Gtk.Label({ label: info.hold || ' ' });
        hold.get_style_context().add_class('hold');
        hold.set_ellipsize(3);            // PANGO_ELLIPSIZE_END
        hold.set_max_width_chars(7);
        const tap = new Gtk.Label({ label: info.tap || ' ' });
        tap.get_style_context().add_class('tap');
        tap.set_ellipsize(3);
        tap.set_max_width_chars(8);

        box.pack_start(hold, false, false, px(2));
        box.pack_start(tap, true, true, 0);
        for (const combo of combos) {
            const line = new Gtk.Label({ label: comboLine(this.model, combo, pos) });
            line.get_style_context().add_class('combo');
            line.set_ellipsize(3);
            line.set_max_width_chars(8);
            box.pack_start(line, false, false, 0);
        }
        ev.add(box);

        const extra = combos.map(c => comboDetail(this.model, c, pos));
        const tip = [info.detail, ...extra].join('\n');
        const hover = [info.detail, ...extra].join(`  ${ch('dot')}  `);
        ev.set_tooltip_text(tip);
        ev.add_events(Gdk.EventMask.ENTER_NOTIFY_MASK | Gdk.EventMask.LEAVE_NOTIFY_MASK);
        ev.connect('enter-notify-event', () => { this.setHover(hover); return false; });
        ev.connect('leave-notify-event', () => { this.setHover(null); return false; });
        return ev;
    }

    buildFooter(px) {
        const footer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: px(1) });
        footer.set_margin_top(px(8));

        this.hoverLabel = new Gtk.Label({ label: '', xalign: 0 });
        this.hoverLabel.set_name('hover');
        this.hoverLabel.set_ellipsize(3);
        this.hoverLabel.set_max_width_chars(1);   // never widen the window
        footer.pack_start(this.hoverLabel, true, true, 0);

        const bits = [];
        for (const combo of this.model.combos) {
            if (!comboLiveOnLayer(this.model, combo, this.state.layer)) continue;
            const keys = combo.positions.map(p => keyLabelAt(this.model, 0, p)).join('+');
            bits.push(`${keys} ${ch('arrow')} ${resolve(this.model, combo.binding).tap}`);
        }
        for (const cond of this.model.conditionals) {
            const names = cond.ifLayers.map(l => layerLabel(this.model, l)).join('+');
            bits.push(`${names} ${ch('arrow')} ${layerLabel(this.model, cond.thenLayer)}`);
        }
        bits.push(`drag to move${ch('mid')}scroll to switch layer`);
        const combos = new Gtk.Label({ label: bits.join(`   ${ch('dot')}   `), xalign: 0 });
        combos.set_name('combos');
        combos.set_ellipsize(3);
        combos.set_max_width_chars(1);
        footer.pack_start(combos, true, true, 0);

        this.setHover(null);
        return footer;
    }

    setHover(text) {
        if (!this.hoverLabel) return;
        const layer = this.model.layers[this.state.layer];
        this.hoverLabel.set_label(text || `${layer.display} layer ${ch('dash')} hover a key for what it does`);
    }

    setLayer(i) {
        this.state.layer = i;
        this.scheduleSave();
        this.build();
    }

    cycleLayer(delta) {
        const n = this.model.layers.length;
        this.setLayer(((this.state.layer + delta) % n + n) % n);
    }

    bumpOpacity(delta) {
        this.state.opacity = Math.min(1.0, Math.max(0.25, this.state.opacity + delta));
        this.win.set_opacity(this.state.opacity);
        this.scheduleSave();
    }

    cycleScale() {
        const steps = [0.85, 1.0, 1.2, 1.45];
        const i = steps.findIndex(v => Math.abs(v - this.state.scale) < 0.01);
        this.state.scale = steps[(i + 1) % steps.length];
        this.scheduleSave();
        this.cssProvider.load_from_data(new TextEncoder().encode(buildCss(this.state.scale)));
        this.build();
    }

    onKey(ev) {
        const [, keyval] = ev.get_keyval();
        const name = Gdk.keyval_name(keyval);
        if (name === 'q' || name === 'Escape') this.quit();
        else if (name === 'plus' || name === 'equal') this.bumpOpacity(0.07);
        else if (name === 'minus') this.bumpOpacity(-0.07);
        else if (name === 's') this.cycleScale();
        else if (name === 'Tab' || name === 'space') this.cycleLayer(1);
        else if (/^[1-9]$/.test(name)) {
            const i = parseInt(name, 10) - 1;
            if (i < this.model.layers.length) this.setLayer(i);
        }
        return true;
    }

    quit() {
        saveState(this.state);
        Gtk.main_quit();
    }
};

/* ------------------------------------------------------------------ *
 * Standalone HTML (--html) — every layer on one page, no GTK involved
 * ------------------------------------------------------------------ */

function esc(text) {
    return String(text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function htmlKey(model, binding, layerIdx, pos) {
    const info = resolve(model, binding || 'none');
    const combos = combosAt(model, layerIdx, pos);
    const cls = ['key'];
    if (info.kind !== 'key' && info.kind !== 'holdtap') cls.push(info.kind);
    if (combos.length) cls.push('has-combo');
    const title = [info.detail, ...combos.map(c => comboDetail(model, c, pos))].join(' — ');
    const comboHtml = combos.map(c =>
        `<span class="combo">${esc(comboLine(model, c, pos))}</span>`).join('');
    return `<div class="${cls.join(' ')}" title="${esc(title)}">`
        + `<span class="hold">${esc(info.hold || ' ')}</span>`
        + `<span class="tap">${esc(info.tap || ' ')}</span>`
        + comboHtml
        + `</div>`;
}

function htmlBoard(model, layer, layerIdx) {
    const halves = [[], []];
    for (let c = 0; c < COLS; c++) {
        const keys = [];
        for (let r = 0; r < ROWS; r++)
            keys.push(htmlKey(model, layer.keys[r * COLS + c], layerIdx, r * COLS + c));
        halves[c < COLS_PER_HALF ? 0 : 1].push(`<div class="col" style="margin-top:${STAGGER[c]}px">${keys.join('')}</div>`);
    }
    const thumbs = [[], []];
    for (let t = 0; t < THUMBS; t++) {
        thumbs[t < THUMBS_PER_HALF ? 0 : 1].push(
            `<div style="margin-top:${THUMB_STAGGER[t]}px">${htmlKey(model, layer.keys[ROWS * COLS + t], layerIdx, ROWS * COLS + t)}</div>`);
    }
    return `<div class="board">
      <div class="half"><div class="cols">${halves[0].join('')}</div>
        <div class="thumbs left">${thumbs[0].join('')}</div></div>
      <div class="half"><div class="cols">${halves[1].join('')}</div>
        <div class="thumbs right">${thumbs[1].join('')}</div></div>
    </div>`;
}

function exportHtml(model, outPath, sourcePath) {
    const sections = model.layers.map((layer, i) => `
    <section>
      <h2><span class="swatch" style="background:${LAYER_ACCENT[i % LAYER_ACCENT.length]}"></span>
        ${esc(layer.display)}<small>${esc(accessHint(model, i))}</small></h2>
      ${htmlBoard(model, layer, i)}
    </section>`).join('\n');

    const extras = [];
    for (const combo of model.combos) {
        const keys = combo.positions.map(pos => keyLabelAt(model, 0, pos)).join(' + ');
        extras.push(`<li><b>${esc(keys)}</b> ${ch('arrow')} ${esc(resolve(model, combo.binding).detail)}
            <em>(within ${esc(combo.timeout)} ms, ${esc(comboScope(model, combo))})</em></li>`);
    }
    for (const cond of model.conditionals) {
        const names = cond.ifLayers.map(l => layerLabel(model, l)).join(' + ');
        extras.push(`<li>hold <b>${esc(names)}</b> ${ch('arrow')} the ${esc(layerLabel(model, cond.thenLayer))} layer</li>`);
    }

    const page = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Piantor Pro BT keymap cheat sheet</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 28px; background: #0f1117; color: #e6e9f0;
         font-family: system-ui, "Segoe UI", Cantarell, sans-serif; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .src { color: #666d80; font-size: 12px; margin-bottom: 26px; }
  section { margin-bottom: 26px; }
  h2 { font-size: 14px; font-weight: 700; margin: 0 0 10px; display: flex;
       align-items: center; gap: 8px; }
  h2 small { color: #666d80; font-weight: 400; font-size: 12px; }
  .swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
  .board { display: flex; gap: 26px; }
  .half { display: flex; flex-direction: column; gap: 6px; }
  .cols { display: flex; gap: 4px; align-items: flex-start; }
  .col { display: flex; flex-direction: column; gap: 4px; }
  .thumbs { display: flex; gap: 4px; align-items: flex-start; }
  .thumbs.left { justify-content: flex-end; }
  .key { width: 46px; min-height: 46px; border-radius: 8px; background: #1b1e28;
         border: 1px solid #2b3040; display: flex; flex-direction: column;
         align-items: center; justify-content: center; padding: 2px 0; }
  .key:hover { border-color: #4d566e; background: #232735; }
  .key .hold { font-size: 9px; line-height: 11px; color: #7cc2ff; min-height: 11px; }
  .key .tap { font-size: 14px; font-weight: 700; line-height: 18px; }
  .key.has-combo { border-color: #5c4d78; }
  .key .combo { font-size: 8px; line-height: 10px; color: #c9a0ff; }
  .key.trans { background: #161821; border-color: #2a2e3a; }
  .key.trans .tap { color: #3b4152; font-size: 11px; }
  .key.mod .tap { color: #98a0b5; font-size: 11px; }
  .key.layer .tap, .key.layer .hold { color: #ffb454; }
  .key.layer .tap { font-size: 11px; }
  .key.macro .tap, .key.macro .hold { color: #a9e34b; }
  .key.macro .tap { font-size: 10px; }
  .key.sys .tap { color: #ff8fa3; font-size: 11px; }
  ul { list-style: none; padding: 0; font-size: 13px; line-height: 1.9; color: #b9c0d4; }
  li b { color: #e6e9f0; } li em { color: #666d80; font-style: normal; font-size: 12px; }
</style></head><body>
<h1>Piantor Pro BT cheat sheet</h1>
<div class="src">generated from ${esc(sourcePath)}${' '}${ch('dot')} hover a key for the full behaviour</div>
${sections}
<section><h2><span class="swatch" style="background:#8a90a3"></span>Combos and conditional layers</h2>
<ul>${extras.join('\n')}</ul></section>
</body></html>
`;
    GLib.file_set_contents(outPath, page);
    print(`wrote ${outPath}`);
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

const DEFAULT_KEYMAP = 'piantor_pro_bt.keymap';

function defaultKeymapPath() {
    // Walk up from this script: tools/keymap-overlay -> repo root -> config/
    let dir = GLib.path_get_dirname(imports.system.programPath || './x');
    for (let i = 0; i < 5; i++) {
        const preferred = GLib.build_filenamev([dir, 'config', DEFAULT_KEYMAP]);
        if (GLib.file_test(preferred, GLib.FileTest.EXISTS))
            return preferred;
        dir = GLib.path_get_dirname(dir);
    }
    return null;
}

function main(argv) {
    const opts = { dump: false, focus: false, scale: 0, html: null };
    let path = null;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dump') opts.dump = true;
        else if (a === '--focus') opts.focus = true;
        else if (a === '--ascii') ASCII = true;
        else if (a === '--scale') opts.scale = parseFloat(argv[++i]);
        else if (a === '--html') opts.html = argv[i + 1] && !argv[i + 1].startsWith('-')
            ? argv[++i] : 'piantor-cheatsheet.html';
        else if (a === '-h' || a === '--help') {
            print('usage: zmk-cheatsheet [path/to/file.keymap] [options]');
            print('  --dump         print the cheat sheet to the terminal and exit');
            print('  --html [FILE]  write a standalone HTML cheat sheet and exit');
            print('  --ascii        plain-text glyphs, for hosts without a Unicode font');
            print('  --focus        let the overlay take keyboard focus (1-9, +/-, s, q)');
            print('  --scale N      0.85 | 1.0 | 1.2 | 1.45');
            return 0;
        } else if (!a.startsWith('-')) path = a;
    }
    if (GLib.getenv('ZMK_CHEATSHEET_ASCII')) ASCII = true;

    path = path || defaultKeymapPath();
    if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS)) {
        printerr(`zmk-cheatsheet: no keymap found${path ? ` at ${path}` : ''}`);
        return 1;
    }

    if (opts.dump || opts.html) {
        const [, bytes] = GLib.file_get_contents(path);
        const model = parseKeymap(new TextDecoder().decode(bytes));
        if (opts.dump) dump(model);
        if (opts.html) exportHtml(model, opts.html, path);
        return 0;
    }

    Gtk.init(null);
    new Overlay(path, opts);
    Gtk.main();
    return 0;
}

imports.system.exit(main(ARGV));
