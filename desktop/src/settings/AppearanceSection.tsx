// Appearance section — themes, fonts, font size, matrix rain settings.

import { useTranslation } from "react-i18next";
import { ThemePalette, THEMES, ThemeId } from "./themes";
import { FONTS, FontId } from "./fonts";
import {
  Section,
  Row,
  Toggle,
  Slider,
  ThemeCard,
  FontCard,
} from "./primitives";
import { MatrixRain } from "./MatrixRain";
import type { NexuSettings } from "./settings-store";

interface Props {
  s: NexuSettings;
  set: (patch: Partial<NexuSettings>) => void;
  t: ThemePalette;
}

export function AppearanceSection({ s, set, t }: Props) {
  const { t: tr } = useTranslation();

  return (
    <Section
      id="appearance"
      kicker={tr("settings.appearance.kicker")}
      label={tr("settings.appearance.section")}
      t={t}
    >
      <Row
        label={tr("settings.appearance.theme")}
        hint={tr("settings.appearance.theme_hint")}
        t={t}
      >
        <div className="grid grid-cols-2 gap-3">
          {(Object.keys(THEMES) as ThemeId[]).map((id) => (
            <ThemeCard
              key={id}
              id={id}
              theme={THEMES[id]}
              themeLabel={tr(`settings.appearance.themes.${id}`)}
              active={s.theme === id}
              onPick={(v) => set({ theme: v })}
              t={t}
            />
          ))}
        </div>
      </Row>

      <Row
        label={tr("settings.appearance.font_family")}
        hint={tr("settings.appearance.font_family_hint")}
        t={t}
      >
        <div className="grid grid-cols-2 gap-3">
          {FONTS.map((f) => (
            <FontCard
              key={f.id}
              font={f}
              active={s.font === f.id}
              sampleSize={s.fontSize}
              onPick={(v: FontId) => set({ font: v })}
              t={t}
              sampleCmd={tr("settings.appearance.sample_cmd")}
              sampleCode={tr("settings.appearance.sample_code")}
              sampleComment={tr("settings.appearance.sample_comment")}
            />
          ))}
        </div>
      </Row>

      <Row
        label={tr("settings.appearance.font_size")}
        hint={tr("settings.appearance.font_size_hint")}
        t={t}
      >
        <Slider
          value={s.fontSize}
          onChange={(v) => set({ fontSize: v })}
          min={11}
          max={20}
          t={t}
          format={(v) => `${v}px`}
        />
      </Row>

      <Row
        label={tr("settings.appearance.rain")}
        hint={tr("settings.appearance.rain_hint")}
        t={t}
      >
        <div className="space-y-4">
          <Toggle
            checked={s.rainOn}
            onChange={(v) => set({ rainOn: v })}
            t={t}
            label={tr("settings.appearance.rain_label")}
            onLabel={tr("settings.nav.on")}
            offLabel={tr("settings.nav.off")}
            enabledLabel={tr("settings.toggle.enabled")}
            disabledLabel={tr("settings.toggle.disabled")}
          />

          <div
            className="rounded border overflow-hidden relative"
            style={{
              borderColor: t.border,
              background: t.bgBase,
              height: 120,
            }}
          >
            <MatrixRain
              enabled={s.rainOn}
              density={s.rainDensity}
              opacity={0.8}
              accent={t.accent}
              fade={t.bgBase}
            />
            {!s.rainOn && (
              <div
                className="absolute inset-0 flex items-center justify-center font-mono text-xs"
                style={{ color: t.textMuted }}
              >
                {tr("settings.appearance.preview_off")}
              </div>
            )}
          </div>

          <div className="grid grid-cols-[120px_1fr] gap-4 items-center">
            <span
              className="font-mono text-[10px] uppercase tracking-wider"
              style={{ color: t.textMuted }}
            >
              {tr("settings.appearance.density")}
            </span>
            <Slider
              value={s.rainDensity}
              onChange={(v) => set({ rainDensity: v })}
              min={10}
              max={28}
              t={t}
              format={(v) =>
                tr("settings.appearance.density_unit", { n: v })
              }
            />
          </div>
          <div className="grid grid-cols-[120px_1fr] gap-4 items-center">
            <span
              className="font-mono text-[10px] uppercase tracking-wider"
              style={{ color: t.textMuted }}
            >
              {tr("settings.appearance.opacity")}
            </span>
            <Slider
              value={Math.round(s.rainOpacity * 100)}
              onChange={(v) => set({ rainOpacity: v / 100 })}
              min={5}
              max={80}
              t={t}
              format={(v) => `${v}%`}
            />
          </div>
        </div>
      </Row>
    </Section>
  );
}
