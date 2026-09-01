/* tslint:disable */
/* eslint-disable */


export type SettingDescriptor = {
    label: string,
    description: string | null,
    kind: DescriptorKind,
    id: number,
    idName: string,
} & SettingDescriptorKV;

export type EnumSettingDescriptor = {
    options: {label: string, description: string | null, index: number}[],
    defaultValue: number,
};

export type PercentageSettingDescriptor = {
    logarithmic: boolean,
    defaultValue: number,
};

export type IntRangeSettingDescriptor = {
    min: number,
    max: number,
    defaultValue: number,
};

export type FloatRangeSettingDescriptor = {
    min: number,
    max: number,
    logarithmic: boolean,
    defaultValue: number,
};

export type BooleanSettingDescriptor = {
    defaultValue: boolean,
};

export type GroupSettingDescriptor = {
    defaultValue: boolean,
    children: SettingDescriptor[],
};

type SettingDescriptorKV =
| {kind: DescriptorKind.Enumeration, value: EnumSettingDescriptor}
| {kind: DescriptorKind.Percentage, value: PercentageSettingDescriptor}
| {kind: DescriptorKind.IntRange, value: IntRangeSettingDescriptor}
| {kind: DescriptorKind.FloatRange, value: FloatRangeSettingDescriptor}
| {kind: DescriptorKind.Boolean, value: BooleanSettingDescriptor}
| {kind: DescriptorKind.Group, value: GroupSettingDescriptor};




export enum DescriptorKind {
    Enumeration = 0,
    Percentage = 1,
    IntRange = 2,
    FloatRange = 3,
    Boolean = 4,
    Group = 5,
}

export class EffectOutput {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    height: number;
    len: number;
    ptr: number;
    width: number;
}

export class NtscConfigurator {
    free(): void;
    [Symbol.dispose](): void;
    constructor();
}

export class NtscEffectBuf {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Apply the effect in-place on the contents of the source buffer, writing to and returning
     * the destination buffer.
     *
     * Pipeline: input -> [resize] -> [rotate] -> [effect] -> output.
     * Each optional step writes to its own intermediate buffer; the final result always ends up
     * in `self.effect_dst`.
     */
    applyEffect(frame_num: number, resize_width: number, resize_height: number, resize_filter: ResizeFilter, pad_to_even: boolean, effect_enabled: boolean, rotation: Rotation, rect_top: number, rect_right: number, rect_bottom: number, rect_left: number): EffectOutput;
    /**
     * Get a pointer to the input/source buffer. This is what the effect will read from, and what you should write to.
     */
    inputBuffer(width: number, height: number): Uint8Array;
    constructor();
    /**
     * Update the effect settings.
     */
    setEffectSettings(settings: NtscConfigurator): void;
}

export class NtscSettingsList {
    free(): void;
    [Symbol.dispose](): void;
    defaultPreset(): string;
    getSettingsList(): string;
    constructor();
    parsePreset(json: string): string;
    settingsFromJSON(json: string): NtscConfigurator;
}

export enum ResizeFilter {
    Nearest = 0,
    Bilinear = 1,
    Bicubic = 2,
}

export enum Rotation {
    None = 0,
    Cw90 = 1,
    Cw180 = 2,
    Cw270 = 3,
}

export function setPanicHook(callback: Function): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_ntscsettingslist_free: (a: number, b: number) => void;
    readonly ntscsettingslist_defaultPreset: (a: number) => [number, number, number, number];
    readonly ntscsettingslist_getSettingsList: (a: number) => [number, number];
    readonly ntscsettingslist_new: () => number;
    readonly ntscsettingslist_parsePreset: (a: number, b: number, c: number) => [number, number, number, number];
    readonly ntscsettingslist_settingsFromJSON: (a: number, b: number, c: number) => [number, number, number];
    readonly __wbg_effectoutput_free: (a: number, b: number) => void;
    readonly __wbg_get_effectoutput_height: (a: number) => number;
    readonly __wbg_get_effectoutput_len: (a: number) => number;
    readonly __wbg_get_effectoutput_ptr: (a: number) => number;
    readonly __wbg_get_effectoutput_width: (a: number) => number;
    readonly __wbg_ntscconfigurator_free: (a: number, b: number) => void;
    readonly __wbg_ntsceffectbuf_free: (a: number, b: number) => void;
    readonly __wbg_set_effectoutput_height: (a: number, b: number) => void;
    readonly __wbg_set_effectoutput_len: (a: number, b: number) => void;
    readonly __wbg_set_effectoutput_ptr: (a: number, b: number) => void;
    readonly __wbg_set_effectoutput_width: (a: number, b: number) => void;
    readonly ntscconfigurator_new: () => number;
    readonly ntsceffectbuf_applyEffect: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number];
    readonly ntsceffectbuf_inputBuffer: (a: number, b: number, c: number) => any;
    readonly ntsceffectbuf_new: () => number;
    readonly ntsceffectbuf_setEffectSettings: (a: number, b: number) => void;
    readonly setPanicHook: (a: any) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
