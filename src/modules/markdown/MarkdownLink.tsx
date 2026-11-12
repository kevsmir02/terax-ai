import { openExternalUrl } from "@/lib/external-link";
import type { ComponentProps, MouseEventHandler } from "react";
import { markdownLinkAction } from "./lib/linkAction";

export type MarkdownLinkProps = ComponentProps<"a"> & {
  node?: unknown;
  onSettled?: () => void;
};

export function MarkdownLink({
  children,
  href,
  node: _node,
  onClick,
  onSettled,
  ...props
}: MarkdownLinkProps) {
  const handleClick: MouseEventHandler<HTMLAnchorElement> = (event) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    // Document content never navigates this webview and never runs an
    // application command. The only outcome a link can produce is the
    // deliberate native opener for an http(s)/mailto/tel target; a relative,
    // file: or any other link is inert.
    event.preventDefault();
    const action = markdownLinkAction(href);
    if (action.kind === "external") {
      void openExternalUrl(action.href, onSettled);
    }
  };

  return (
    <a
      {...props}
      href={href}
      onClick={handleClick}
      onAuxClick={(event) => event.preventDefault()}
      rel="noreferrer"
    >
      {children}
    </a>
  );
}
