// DialogHost — mounted once by App, renders the themed confirm/prompt modals
// whenever a component anywhere in the tree calls askConfirm/askPrompt.

import { ConfirmDialog } from "./ConfirmDialog";
import { PromptDialog } from "./PromptDialog";
import { ChoiceDialog } from "./ChoiceDialog";
import { useDialogState } from "./dialogs";

export function DialogHost() {
  const { confirm, prompt, choice, resolveConfirm, resolvePrompt, resolveChoice } =
    useDialogState();
  return (
    <>
      {confirm && (
        <ConfirmDialog
          message={confirm.message}
          title={confirm.title}
          confirmLabel={confirm.confirmLabel}
          cancelLabel={confirm.cancelLabel}
          destructive={confirm.destructive}
          onConfirm={() => resolveConfirm(true)}
          onCancel={() => resolveConfirm(false)}
        />
      )}
      {prompt && (
        <PromptDialog
          message={prompt.message}
          title={prompt.title}
          placeholder={prompt.placeholder}
          defaultValue={prompt.defaultValue}
          confirmLabel={prompt.confirmLabel}
          cancelLabel={prompt.cancelLabel}
          onSubmit={(v) => resolvePrompt(v)}
          onCancel={() => resolvePrompt(null)}
        />
      )}
      {choice && (
        <ChoiceDialog
          message={choice.message}
          title={choice.title}
          options={choice.options}
          cancelLabel={choice.cancelLabel}
          onChoose={(v) => resolveChoice(v)}
          onCancel={() => resolveChoice(null)}
        />
      )}
    </>
  );
}
