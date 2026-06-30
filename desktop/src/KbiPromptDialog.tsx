// KbiPromptDialog — keyboard-interactive (MFA / 2FA) prompt. The backend emits
// `ssh-kbi` with the server's prompts mid-handshake; the user types the 2FA/OTP
// code here and the answers go back via ssh_kbi_respond. Without this, the client
// blindly sent the password to every prompt and MFA hosts failed ("auth failed").

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button, Input } from "./components/primitives";
import { useBackdropClose } from "./useBackdropClose";

export interface KbiRequest {
  session_id: string;
  name: string;
  instruction: string;
  prompts: { prompt: string; echo: boolean }[];
}

interface Props {
  req: KbiRequest;
  onSubmit: (answers: string[]) => void;
  onCancel: () => void;
}

export function KbiPromptDialog({ req, onSubmit, onCancel }: Props) {
  const [vals, setVals] = useState<string[]>(req.prompts.map(() => ""));
  const { backdropProps, contentProps } = useBackdropClose(onCancel);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter") {
        e.preventDefault();
        onSubmit(vals);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onSubmit, vals]);

  return (
    <div className="nx-scrim grid place-items-center" {...backdropProps}>
      <form
        {...contentProps}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(vals);
        }}
        className="nx-modal-enter relative w-[440px] max-w-[92vw] bg-nx-panel rounded-nx-lg p-6 shadow-elev-modal"
      >
        <div className="flex items-center gap-2 mb-2 font-mono">
          <ShieldCheck size={15} className="text-nx-accent" />
          <span className="text-lead text-nx-text">
            {req.name || "Двухфакторная аутентификация"}
          </span>
        </div>
        {req.instruction && (
          <div className="font-mono text-sm text-nx-muted mb-3 whitespace-pre-line">
            {req.instruction}
          </div>
        )}
        <div className="flex flex-col gap-3 mb-5">
          {req.prompts.map((p, i) => (
            <div key={i}>
              <label className="block text-meta text-nx-muted mb-1 font-mono">
                {p.prompt}
              </label>
              <Input
                autoFocus={i === 0}
                type={p.echo ? "text" : "password"}
                value={vals[i]}
                onChange={(v) =>
                  setVals((a) => a.map((x, j) => (j === i ? v : x)))
                }
              />
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Отмена
          </Button>
          <Button type="submit" variant="primary">
            OK
          </Button>
        </div>
      </form>
    </div>
  );
}
