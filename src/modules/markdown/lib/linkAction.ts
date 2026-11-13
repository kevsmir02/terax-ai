// What a Markdown link is allowed to do. Kept pure so the rule is testable
// without a DOM: document content may only reach the native opener for a
// supported external target. Every other href is inert — it never navigates the
// application webview and never runs an application command.

import { isExternalUrl } from "@/lib/external-link";

export type MarkdownLinkAction =
  | { readonly kind: "external"; readonly href: string }
  | { readonly kind: "inert" };

export function markdownLinkAction(
  href: string | null | undefined,
): MarkdownLinkAction {
  return href && isExternalUrl(href)
    ? { kind: "external", href }
    : { kind: "inert" };
}
