type ToolAction = { readonly toolName: string; readonly args: unknown };

const labels: Record<string, string> = {
  inspect_page: "查看页面", inspect_pages: "查看页面", find_elements: "查找页面元素", list_frames: "查看页面框架",
  click: "点击", double_click: "双击", hover: "移动到", focus_element: "聚焦", blur_element: "移开焦点",
  fill: "填写", type_text: "输入文字", press_key: "按下按键", key_down: "按住按键", key_up: "松开按键",
  set_checked: "设置选中状态", select_option: "选择选项", drag: "拖动元素", scroll: "滚动页面",
  move_pointer: "移动指针", press_pointer: "按下鼠标", release_pointer: "松开鼠标",
  read_text: "读取文本", read_value: "读取输入值", read_checked: "读取选中状态", read_attribute: "读取元素属性",
  verify_state: "检查页面状态", wait_for_url: "等待页面地址变化", navigate: "打开页面", reload: "重新加载页面",
  go_back: "返回上一页", go_forward: "前往下一页", list_tabs: "查看标签页", open_tab: "打开标签页",
  switch_tab: "切换标签页", close_tab: "关闭标签页", upload_file: "上传文件", take_screenshot: "截取页面截图",
  create_pdf: "生成页面 PDF", read_artifact: "读取保存的内容", create_text_artifact: "保存文本", save_artifact: "导出文件",
  list_scripts: "查看用户脚本", read_script: "读取用户脚本", create_script: "创建用户脚本", update_script: "编辑用户脚本",
  set_script_enabled: "设置用户脚本状态", delete_script: "删除用户脚本", list_requests: "查看网络请求",
  read_response: "读取网络响应", read_console: "查看控制台消息", fetch: "发送网络请求",
  evaluate_js: "执行页面脚本", list_cdp_sessions: "查看浏览器调试会话", send_cdp: "执行浏览器调试操作",
  list_downloads: "查看下载记录", subscribe_event: "订阅浏览器事件", wait_event: "等待浏览器事件",
  unsubscribe_event: "停止订阅浏览器事件", handle_dialog: "处理浏览器对话框", read_api_reference: "查看操作说明",
  execute_program: "执行浏览器操作", list_jobs: "查看后台任务", get_job: "查看后台任务状态", cancel_job: "停止后台任务",
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function shortText(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.length > 36 ? `${text.slice(0, 36)}…` : text : undefined;
}

/** Describe the requested action, without implying that it succeeded. */
export function toolAction(part: ToolAction): string {
  const args = record(part.args);
  const target = record(args?.target);
  // A CSS selector or opaque ref is not a useful human-facing element name.
  const targetName = target && target.by !== "css" && target.by !== "testId" && target.by !== undefined
    ? shortText(target.name) ?? (target.by === "role" ? undefined : shortText(target.value)) : undefined;
  const action = labels[part.toolName] ?? "执行浏览器操作";
  if (targetName && ["click", "double_click", "hover", "focus_element", "blur_element", "fill", "type_text", "read_text", "read_value", "read_checked", "read_attribute", "select_option", "set_checked"].includes(part.toolName)) return `${action}「${targetName}」`;
  if (["press_key", "key_down", "key_up"].includes(part.toolName)) {
    const key = shortText(args?.key);
    if (key) return `${action}「${key}」`;
  }
  if (part.toolName === "set_script_enabled" && typeof args?.enabled === "boolean") return args.enabled ? "启用用户脚本" : "停用用户脚本";
  if (part.toolName === "get_job" && typeof args?.waitMs === "number" && args.waitMs > 0) return "等待后台任务";
  return action;
}

/** Keep action order while avoiding repeated labels in a single summary. */
export function summarizeToolActions(parts: readonly ToolAction[]): string {
  const actions = parts.map(toolAction).filter((action, index, all) => index === 0 || action !== all[index - 1]);
  if (actions.length <= 1) return actions[0] ?? "执行浏览器操作";
  if (actions.length > 3) return `${actions.slice(0, 3).join("、")}等操作`;
  return `${actions.slice(0, -1).join("、")}并${actions.at(-1)}`;
}
