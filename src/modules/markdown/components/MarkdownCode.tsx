// Streamdown `components.code` override for rendered Markdown: inline code
// stays a plain pill, fenced blocks delegate to the shared code block.

import { isValidElement, type ReactNode } from "react";

import { CodeBlock } from "./CodeBlock";

export function markdownCodeText(children?: ReactNode): string {
  if (children == null || typeof children === "boolean") return "";
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map((child) => markdownCodeText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(children)) {
    return markdownCodeText(children.props.children);
  }
  return "";
}

/**
 * Handles both inline (`code`) and fenced blocks (className "language-X").
 * Fenced blocks render highlighted code with copy and run actions; inline
 * code is a plain pill.
 */
export function MarkdownCode({
  className,
  children,
  ...rest
}: {
  className?: string;
  children?: ReactNode;
}) {
  const match = className?.match(/language-(\w+)/);
  if (!match) {
    return (
      <code
        className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[0.875em] text-foreground"
        {...rest}
      >
        {children}
      </code>
    );
  }

  const code = markdownCodeText(children).replace(/\n$/, "");
  return <CodeBlock code={code} lang={match[1] ?? null} />;
}
