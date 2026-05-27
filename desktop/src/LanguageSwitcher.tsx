import { useTranslation } from "react-i18next";
import { setLang } from "./i18n";

export function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const cur = i18n.language === "ru" ? "ru" : "en";
  return (
    <div className="flex gap-1 text-xs font-mono">
      {(["ru", "en"] as const).map((l) => (
        <button
          key={l}
          onClick={() => setLang(l)}
          className={
            "px-2 py-0.5 rounded " +
            (cur === l
              ? "text-[#00ff95]"
              : "text-[#4a5560] hover:text-[#7fd7ff]")
          }
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
