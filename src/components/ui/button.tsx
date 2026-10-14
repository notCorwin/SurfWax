import * as React from "react"
import { classes } from "@/classes"

type ButtonVariant = "default" | "destructive" | "outline" | "secondary" | "ghost" | "link"
type ButtonSize = "default" | "xs" | "sm" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg"

const buttonClasses = [
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md bg-transparent text-sm font-medium text-foreground whitespace-nowrap transition-[background-color,color,border-color,opacity] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  "data-[variant=default]:bg-surface-selected data-[variant=default]:text-brand data-[variant=default]:hover:bg-surface-hover",
  "data-[variant=destructive]:bg-destructive/10 data-[variant=destructive]:text-destructive data-[variant=destructive]:hover:bg-destructive/15",
  "data-[variant=outline]:border data-[variant=outline]:border-surface-stroke data-[variant=outline]:hover:bg-surface-hover",
  "data-[variant=secondary]:bg-surface-selected data-[variant=secondary]:text-brand data-[variant=secondary]:hover:bg-surface-hover",
  "data-[variant=ghost]:hover:bg-surface-hover",
  "data-[variant=link]:text-brand data-[variant=link]:underline-offset-4 data-[variant=link]:hover:underline",
  "data-[size=default]:h-9 data-[size=default]:px-4 data-[size=default]:py-2 data-[size=default]:has-[>svg]:px-3",
  "data-[size=xs]:h-6 data-[size=xs]:gap-1 data-[size=xs]:rounded-md data-[size=xs]:px-2 data-[size=xs]:text-xs data-[size=xs]:has-[>svg]:px-1.5 data-[size=xs]:[&_svg:not([class*='size-'])]:size-3",
  "data-[size=sm]:h-8 data-[size=sm]:gap-1.5 data-[size=sm]:rounded-md data-[size=sm]:px-3 data-[size=sm]:has-[>svg]:px-2.5",
  "data-[size=lg]:h-10 data-[size=lg]:rounded-md data-[size=lg]:px-6 data-[size=lg]:has-[>svg]:px-4",
  "data-[size=icon]:size-9 data-[size=icon-xs]:size-6 data-[size=icon-xs]:rounded-md data-[size=icon-xs]:[&_svg:not([class*='size-'])]:size-3 data-[size=icon-sm]:size-8 data-[size=icon-lg]:size-10",
].join(" ")

type ButtonStyleProps = {
  className?: string
  variant?: ButtonVariant
  size?: ButtonSize
}

function buttonClassName({ className }: ButtonStyleProps = {}) {
  return classes(buttonClasses, className)
}

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<"button"> & ButtonStyleProps) {
  return (
    <button
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={buttonClassName({ className })}
      {...props}
    />
  )
}

export { Button, buttonClassName }
export type { ButtonSize, ButtonVariant }
