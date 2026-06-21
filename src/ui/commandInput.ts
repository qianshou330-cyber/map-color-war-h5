import type { CommandResult, GameState } from "../types";
import { executeCommand, parseCommand } from "../game/commands";
import { playSfx, unlockSfx } from "../audio/sfx";

const COMMAND_PREFIXES = ["加入", "进攻全部", "进攻", "结盟", "退出结盟", "停战全部", "停战"];

export function bindCommandInput(
  form: HTMLFormElement,
  input: HTMLInputElement,
  getState: () => GameState | null,
  afterCommand: () => void,
  onCommandLogged?: (inputText: string, result: CommandResult) => void,
  submitCommand?: (inputText: string, state: GameState) => CommandResult | void
): void {
  bindShortcutButtons(form, input);

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    unlockSfx();
    playSfx("click");
    const state = getState();
    if (!state) {
      input.value = "";
      return;
    }

    const inputText = input.value.trim();
    if (submitCommand) {
      const result = submitCommand(inputText, state);
      if (result) {
        playSfx(result.ok ? "click" : "error");
        onCommandLogged?.(inputText, result);
      }
      input.value = "";
      afterCommand();
      return;
    }

    const parsed = parseCommand(inputText);

    if ("error" in parsed) {
      state.message = parsed.error;
      playSfx("error");
      onCommandLogged?.(inputText, {
        ok: false,
        message: parsed.error
      });
      afterCommand();
      return;
    }

    const result = executeCommand(state, parsed);
    if (!result.ok) {
      playSfx("error");
    }
    onCommandLogged?.(inputText, result);
    input.value = "";
    afterCommand();
  });
}

function bindShortcutButtons(form: HTMLFormElement, input: HTMLInputElement): void {
  const buttons = form.querySelectorAll<HTMLButtonElement>("[data-command-prefix]");
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      unlockSfx();
      playSfx("click");
      const prefix = button.dataset.commandPrefix;
      if (!prefix) {
        return;
      }

      input.value = buildShortcutCommand(prefix, input.value);
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  });
}

function buildShortcutCommand(prefix: string, currentValue: string): string {
  const trimmed = currentValue.trim();
  const existingPrefix = COMMAND_PREFIXES.find((candidate) => trimmed.startsWith(candidate));
  const rest = existingPrefix ? trimmed.slice(existingPrefix.length).trim() : trimmed;
  const digits = rest.match(/\d+/)?.[0] ?? "";
  return `${prefix}${digits}`;
}
