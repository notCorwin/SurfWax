import * as React from "react"
import { classes } from "@/classes"

import { Button, type ButtonSize } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      data-focus-group=""
      role="group"
      className={classes(
        "group/input-group relative flex h-9 min-w-0 w-full items-center rounded-md border border-input shadow-xs transition-[color,box-shadow] has-[>textarea]:h-auto has-[>[data-align=inline-start]]:[&>input]:pl-2 has-[>[data-align=inline-end]]:[&>input]:pr-2 has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col has-[>[data-align=block-start]]:[&>input]:pb-3 has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-end]]:[&>input]:pt-3 has-[[data-slot][aria-invalid=true]]:border-destructive dark:bg-input/30",
        className
      )}
      {...props}
    />
  )
}

type InputGroupAddonAlign = "inline-start" | "inline-end" | "block-start" | "block-end"

function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: React.ComponentProps<"div"> & { align?: InputGroupAddonAlign }) {
  return (
    <div
      role="group"
      data-slot="input-group-addon"
      data-align={align}
      className={classes(
        "flex h-auto cursor-text items-center justify-center gap-2 py-1.5 text-sm font-medium text-muted-foreground select-none group-data-[disabled=true]/input-group:opacity-50 [&>kbd]:rounded-[calc(var(--radius)-5px)] [&>svg:not([class*='size-'])]:size-4 data-[align=inline-start]:order-first data-[align=inline-start]:pl-3 data-[align=inline-start]:has-[>button]:ml-[-0.45rem] data-[align=inline-start]:has-[>kbd]:ml-[-0.35rem] data-[align=inline-end]:order-last data-[align=inline-end]:pr-3 data-[align=inline-end]:has-[>button]:mr-[-0.45rem] data-[align=inline-end]:has-[>kbd]:mr-[-0.35rem] data-[align=block-start]:order-first data-[align=block-start]:w-full data-[align=block-start]:justify-start data-[align=block-start]:px-3 data-[align=block-start]:pt-3 data-[align=block-start]:group-has-[>input]/input-group:pt-2.5 data-[align=block-start]:[.border-b]:pb-3 data-[align=block-end]:order-last data-[align=block-end]:w-full data-[align=block-end]:justify-start data-[align=block-end]:px-3 data-[align=block-end]:pb-3 data-[align=block-end]:group-has-[>input]/input-group:pb-2.5 data-[align=block-end]:[.border-t]:pt-3",
        className
      )}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button")) return
        event.currentTarget.parentElement?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")?.focus()
      }}
      {...props}
    />
  )
}

function InputGroupButton({
  className,
  type = "button",
  variant = "ghost",
  size = "xs",
  ...props
}: React.ComponentProps<typeof Button> & { size?: Extract<ButtonSize, "xs" | "sm" | "icon-xs" | "icon-sm"> }) {
  return <Button type={type} variant={variant} size={size} className={classes("shadow-none", className)} {...props} />
}

function InputGroupText({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={classes("flex items-center gap-2 text-sm text-muted-foreground [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4", className)} {...props} />
}

function InputGroupInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <Input
      data-slot="input-group-control"
      data-focus-delegate=""
      className={classes("flex-1 !rounded-none !border-0 !bg-transparent !shadow-none", className)}
      {...props}
    />
  )
}

function InputGroupTextarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <Textarea
      data-slot="input-group-control"
      data-focus-delegate=""
      className={classes("flex-1 !resize-none !rounded-none !border-0 !bg-transparent py-3 !shadow-none", className)}
      {...props}
    />
  )
}

export {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupInput,
  InputGroupTextarea,
}
