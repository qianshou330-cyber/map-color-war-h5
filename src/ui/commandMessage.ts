import type { GameState } from "../types";

export function renderCommandMessage(root: HTMLElement, state: GameState): void {
  root.textContent = state.message;
  root.classList.toggle("is-success", getMessageTone(state.message) === "success");
  root.classList.toggle("is-error", getMessageTone(state.message) === "error");
  root.classList.toggle("is-info", getMessageTone(state.message) === "info");
}

function getMessageTone(message: string): "success" | "error" | "info" {
  if (
    /失败|错误|不能|请先|必须|没有|无效|不可|只能|暂无|太小|格式|未加入|断开|异常/.test(message)
  ) {
    return "error";
  }

  if (/已|开始|成功|加入|结盟|停战|昵称|保存|生成|连接/.test(message)) {
    return "success";
  }

  return "info";
}
