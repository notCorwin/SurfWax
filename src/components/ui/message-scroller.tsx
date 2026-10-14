"use client"

import * as React from "react"
import { classes } from "@/classes"
import { ArrowDownIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

type Direction = "start" | "end"
type Scrollable = Record<Direction, boolean>
type MessageScrollerContextValue = {
  scrollable: Scrollable
  setViewport: (viewport: HTMLDivElement | null) => void
  viewport: HTMLDivElement | null
}

const MessageScrollerContext = React.createContext<MessageScrollerContextValue | null>(null)

function useMessageScroller() {
  const context = React.useContext(MessageScrollerContext)
  if (!context) throw new Error("MessageScroller components must be inside MessageScrollerProvider")
  return context
}

function useMessageScrollerScrollable() {
  return useMessageScroller().scrollable
}

function MessageScrollerProvider({
  children,
}: React.PropsWithChildren<{ autoScroll?: boolean }>) {
  const [viewport, setViewport] = React.useState<HTMLDivElement | null>(null)
  const [scrollable, setScrollable] = React.useState<Scrollable>({ start: false, end: false })

  React.useLayoutEffect(() => {
    if (!viewport) return
    let frame: number | undefined
    const update = () => {
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        const max = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
        const next = { start: viewport.scrollTop > 2, end: max - viewport.scrollTop > 2 }
        setScrollable((current) => current.start === next.start && current.end === next.end ? current : next)
      })
    }
    const resize = new ResizeObserver(update)
    resize.observe(viewport)
    for (const child of viewport.children) resize.observe(child)
    const mutations = new MutationObserver(() => {
      for (const child of viewport.children) resize.observe(child)
      update()
    })
    mutations.observe(viewport, { childList: true })
    viewport.addEventListener("scroll", update, { passive: true })
    update()
    return () => {
      viewport.removeEventListener("scroll", update)
      resize.disconnect()
      mutations.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [viewport])

  const value = React.useMemo(() => ({ scrollable, setViewport, viewport }), [scrollable, viewport])
  return <MessageScrollerContext value={value}>{children}</MessageScrollerContext>
}

function MessageScroller({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-scroller"
      className={classes(
        "group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden",
        className
      )}
      {...props}
    />
  )
}

const MessageScrollerViewport = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  function MessageScrollerViewport({ className, onScroll, ...props }, forwardedRef) {
    const { setViewport } = useMessageScroller()
    const ref = React.useCallback((node: HTMLDivElement | null) => {
      setViewport(node)
      if (typeof forwardedRef === "function") forwardedRef(node)
      else if (forwardedRef) forwardedRef.current = node
    }, [forwardedRef, setViewport])
    return (
      <div
        ref={ref}
        data-slot="message-scroller-viewport"
        className={classes(
          "size-full min-h-0 min-w-0 scroll-fade-b scrollbar-thin scrollbar-gutter-stable overflow-y-auto overscroll-contain contain-content data-autoscrolling:scrollbar-none data-pending-scroll:invisible",
          className
        )}
        onScroll={onScroll}
        {...props}
      />
    )
  }
)

function MessageScrollerContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-scroller-content"
      className={classes("flex h-max min-h-full flex-col gap-8", className)}
      {...props}
    />
  )
}

function MessageScrollerItem({
  className,
  scrollAnchor: _scrollAnchor = false,
  ...props
}: React.ComponentProps<"div"> & { scrollAnchor?: boolean }) {
  return (
    <div
      data-slot="message-scroller-item"
      className={classes(
        "min-w-0 shrink-0 [contain-intrinsic-size:auto_10rem] [content-visibility:auto]",
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerButton({
  direction = "end",
  className,
  children,
  variant = "secondary",
  size = "icon-sm",
  onClick,
  ...props
}: React.ComponentProps<typeof Button> & { direction?: Direction }) {
  const { scrollable, viewport } = useMessageScroller()
  const active = scrollable[direction]
  return (
    <Button
      data-slot="message-scroller-button"
      data-direction={direction}
      data-active={active}
      variant={variant}
      size={size}
      aria-hidden={!active}
      tabIndex={active ? undefined : -1}
      className={classes(
        "absolute inset-s-1/2 -translate-x-1/2 border-border bg-background text-foreground transition-[translate,scale,opacity] duration-(--motion-normal) hover:bg-muted hover:text-foreground data-[active=false]:pointer-events-none data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=false]:duration-(--motion-slow) data-[active=false]:ease-[cubic-bezier(0.7,0,0.84,0)] data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100 data-[active=true]:ease-[cubic-bezier(0.23,1,0.32,1)] data-[direction=end]:bottom-4 data-[direction=end]:data-[active=false]:translate-y-full data-[direction=start]:top-4 data-[direction=start]:data-[active=false]:-translate-y-full rtl:translate-x-1/2 data-[direction=start]:[&_svg]:rotate-180",
        className
      )}
      onClick={(event) => {
        if (viewport) viewport.scrollTop = direction === "end" ? viewport.scrollHeight : 0
        onClick?.(event)
      }}
      {...props}
    >
      {children ?? (
        <>
          <ArrowDownIcon />
          <span className="sr-only">
            {direction === "end" ? "Scroll to end" : "Scroll to start"}
          </span>
        </>
      )}
    </Button>
  )
}

export {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
  useMessageScroller,
  useMessageScrollerScrollable,
}
