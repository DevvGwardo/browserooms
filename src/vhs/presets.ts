export type VhsPreset = {
  id: string;
  label: string;
  height: number;
  fps: number;
  settings: Record<string, number | boolean>;
};

const common = {
  version: 1,
  random_seed: 47,
  use_field: 4,
  filter_type: 1,
  input_luma_filter: 2,
  chroma_lowpass_in: 2,
  chroma_lowpass_out: 2,
  composite_preemphasis: 0.4,
  composite_noise: true,
  composite_noise_intensity: 0.014,
  composite_noise_frequency: 0.5,
  composite_noise_detail: 1,
  snow_intensity: 0.000015,
  video_scanline_phase_shift: 2,
  video_scanline_phase_shift_offset: 0,
  chroma_demodulation: 1,
  luma_smear: 0.14,
  head_switching: true,
  head_switching_height: 3,
  head_switching_offset: 1,
  head_switching_horizontal_shift: 4,
  head_switching_start_mid_line: true,
  head_switching_mid_line_position: 0.95,
  head_switching_mid_line_jitter: 0.008,
  tracking_noise: false,
  ringing: true,
  ringing_frequency: 0.45,
  ringing_power: 2,
  ringing_scale: 0.45,
  luma_noise: true,
  luma_noise_intensity: 0.004,
  luma_noise_frequency: 0.5,
  luma_noise_detail: 1,
  chroma_noise: true,
  chroma_noise_intensity: 0.012,
  chroma_noise_frequency: 0.045,
  chroma_noise_detail: 2,
  // Keep the scene's yellow/white balance; artifacts should not impose a new hue.
  chroma_phase_error: 0,
  chroma_phase_noise_intensity: 0.0003,
  chroma_delay_horizontal: 0.35,
  chroma_delay_vertical: 0,
  vhs_settings: true,
  vhs_tape_speed: 1,
  vhs_chroma_loss: 0.000002,
  vhs_sharpen_enabled: true,
  vhs_sharpen: 0.18,
  vhs_sharpen_frequency: 1,
  vhs_edge_wave_enabled: true,
  vhs_edge_wave: 0.12,
  vhs_edge_wave_speed: 0.7,
  vhs_edge_wave_frequency: 0.025,
  vhs_edge_wave_detail: 2,
  vhs_chroma_vert_blend: true,
  scale_settings: true,
  bandwidth_scale: 1,
  vertical_scale: 1,
  scale_with_video_size: false,
};

export const VHS_PRESETS: VhsPreset[] = [
  { id: "clean", label: "Clean", height: 0, fps: 0, settings: {} },
  { id: "fresh", label: "Fresh tape (SP)", height: 480, fps: 30000 / 1001, settings: {
    ...common, chroma_lowpass_in: 1, chroma_lowpass_out: 1, chroma_demodulation: 3,
    composite_noise_intensity: 0.004, luma_noise_intensity: 0.0015, chroma_noise_intensity: 0.004,
    luma_smear: 0.035, head_switching: false, vhs_edge_wave_enabled: false, snow_intensity: 0,
    chroma_delay_horizontal: 0, chroma_phase_noise_intensity: 0.0001,
  } },
  { id: "camcorder", label: "Camcorder (SP)", height: 480, fps: 30000 / 1001, settings: { ...common } },
  { id: "home-video", label: "Home video (LP)", height: 480, fps: 30000 / 1001, settings: {
    ...common, vhs_tape_speed: 2, composite_noise_intensity: 0.025,
    luma_noise_intensity: 0.007, chroma_noise_intensity: 0.035, luma_smear: 0.32,
    head_switching_height: 5, head_switching_horizontal_shift: 10,
    vhs_edge_wave: 0.32, vhs_edge_wave_speed: 1.1, chroma_delay_horizontal: 0.7,
    snow_intensity: 0.00006, vhs_chroma_loss: 0.000035,
  } },
  { id: "worn", label: "Worn tape (EP)", height: 480, fps: 30000 / 1001, settings: {
    ...common, vhs_tape_speed: 3, composite_noise_intensity: 0.04,
    luma_noise_intensity: 0.015, chroma_noise_intensity: 0.07, luma_smear: 0.46,
    head_switching_height: 8, head_switching_horizontal_shift: 22,
    vhs_edge_wave: 0.7, vhs_edge_wave_speed: 1.7, chroma_delay_horizontal: 1.1,
    snow_intensity: 0.00035, vhs_chroma_loss: 0.00015,
    tracking_noise: true, tracking_noise_height: 5, tracking_noise_wave_intensity: 2.5,
    tracking_noise_snow_intensity: 0.003, tracking_noise_noise_intensity: 0.04,
  } },
];

export function getVhsPreset(id: string | null) {
  return VHS_PRESETS.find((preset) => preset.id === id) ?? VHS_PRESETS[2];
}
