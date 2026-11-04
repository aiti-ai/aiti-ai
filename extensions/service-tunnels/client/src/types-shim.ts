/**
 * service-tunnels 库 ParamSpec 的类型镜像（编译期用；运行时不引用库）。
 * 字段来自 vendor/service-tunnels/dist/*.d.ts 的 ParamSpec。
 */
export interface ParamSpecOption {
  value: string;
  label?: string;
  labelKey?: string;
  hint?: string;
  hintKey?: string;
  default?: boolean;
}
export interface ParamSpec {
  key: string;
  label?: string;
  labelKey?: string;
  description?: string;
  descriptionKey?: string;
  placeholder?: string;
  placeholderKey?: string;
  linkTitle?: string;
  linkTitleKey?: string;
  default?: string | boolean | number;
  type?: "text" | "password" | "number" | "boolean" | "select" | "multiselect";
  options?: ParamSpecOption[];
  required?: boolean;
  hidden?: boolean;
  fixed?: boolean;
  value?: string;
  [key: string]: unknown;
}
