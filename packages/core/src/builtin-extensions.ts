import type { IExtension } from "@piccolo/api";
import { CompactExtension } from "@piccolo/compact";
import type { LanguageModel } from "ai";

export interface BuiltinExtensionBinding {
  bindingName: string;
  extension: IExtension;
}

export function builtinExtensions(
  getModel: (() => LanguageModel) | undefined,
): BuiltinExtensionBinding[] {
  if (getModel === undefined) return [];
  return [
    {
      bindingName: "BUILTIN_piccolo/compact",
      extension: new CompactExtension(getModel),
    },
  ];
}
