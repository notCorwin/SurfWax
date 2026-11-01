"use client"

import * as React from "react"
import { cn } from "cn"
import { ArrowDownIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

type Scrollable = { start: boolean; end: boolean }
type ScrollOptions = { behavior?: ScrollBehavior }

// Following is user intent, not a deduction from the current scroll offset.
// Virtual measurement, content growth and viewport resizing can all change the
// offset independently of a user choosing to read earlier messages.
class MessageScrollController {
  viewport: HTMLDivElement | null = null
  content: HTMLDivElement | null = null
  private following: boolean
  private frame: number | null = null
  private resize: ResizeObserver | null = null
  private mutations: MutationObserver | null = null
  private listeners = new Set<() => void>()
  private snapshot: Scrollable = { start: false, end: false }

  constructor(private autoScroll: boolean) { this.following = autoScroll }

  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private atEnd() {
    const viewport = this.viewport
    return !!viewport && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 1
  }

  private publish() {
    const viewport = this.viewport
    const next = {
      start: !!viewport && viewport.scrollTop > 1,
      end: !!viewport && !this.atEnd(),
    }
    if (next.start !== this.snapshot.start || next.end !== this.snapshot.end) {
      this.snapshot = next
      this.listeners.forEach((listener) => listener())
    }
  }

  private schedule = () => {
    if (this.frame !== null) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      if (this.following && this.viewport) this.viewport.scrollTop = this.viewport.scrollHeight
      this.publish()
    })
  }

  private observe() {
    this.resize?.disconnect()
    this.mutations?.disconnect()
    this.resize = new ResizeObserver(this.schedule)
    if (this.viewport) this.resize.observe(this.viewport)
    if (this.content) {
      this.resize.observe(this.content)
      this.mutations = new MutationObserver(this.schedule)
      // Virtualized turns change their spacer height after measurement. Observe
      // those layout mutations as well as later Markdown/content additions.
      this.mutations.observe(this.content, { subtree: true, childList: true, characterData: true, attributes: true })
    }
    this.schedule()
  }

  setViewport = (viewport: HTMLDivElement | null) => {
    this.viewport = viewport
    this.observe()
  }
  setContent = (content: HTMLDivElement | null) => {
    this.content = content
    this.observe()
  }
  pause = () => { this.following = false }
  onScroll = () => {
    if (this.atEnd()) this.following = this.autoScroll
    this.publish()
  }
  scrollToEnd = ({ behavior = "auto" }: ScrollOptions = {}) => {
    if (!this.viewport) return false
    this.following = this.autoScroll
    this.viewport.scrollTo({ top: this.viewport.scrollHeight, behavior })
    this.publish()
    return true
  }
  scrollToStart = ({ behavior = "auto" }: ScrollOptions = {}) => {
    if (!this.viewport) return false
    this.following = false
    this.viewport.scrollTo({ top: 0, behavior })
    this.publish()
    return true
  }
  dispose = () => {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    this.resize?.disconnect()
    this.mutations?.disconnect()
  }
}

const MessageScrollerContext = React.createContext<MessageScrollController | null>(null)
function useMessageScroller() {
  const controller = React.useContext(MessageScrollerContext)
  if (!controller) throw new Error("MessageScroller must be inside MessageScrollerProvider")
  return controller
}
function useMessageScrollerScrollable() {
  const controller = useMessageScroller()
  return React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
}
function MessageScrollerProvider({ autoScroll = false, children }: { autoScroll?: boolean; children?: React.ReactNode }) {
  const controller = React.useMemo(() => new MessageScrollController(autoScroll), [autoScroll])
  React.useEffect(() => () => controller.dispose(), [controller])
  return <MessageScrollerContext.Provider value={controller}>{children}</MessageScrollerContext.Provider>
}
function MessageScroller({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="message-scroller" className={cn("group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden", className)} {...props} />
}

function setRef<T>(ref: React.Ref<T> | undefined, value: T) {
  if (typeof ref === "function") {
    const cleanup = ref(value)
    return typeof cleanup === "function" ? cleanup : () => ref(null)
  }
  if (ref) ref.current = value
  return () => { if (ref) ref.current = null }
}

function MessageScrollerViewport({
  className, ref, onWheel, onKeyDown, onTouchStart, onTouchMove, onPointerDown, onScroll, ...props
}: React.ComponentProps<"div">) {
  const controller = useMessageScroller()
  const touchY = React.useRef<number | null>(null)
  const attach = React.useCallback((node: HTMLDivElement | null) => {
    controller.setViewport(node)
    const cleanup = setRef(ref, node)
    return () => { cleanup(); controller.setViewport(null) }
  }, [controller, ref])
  return <div data-slot="message-scroller-viewport" role="region" aria-label="Messages" tabIndex={0}
    className={cn("size-full min-h-0 min-w-0 scroll-fade-b scrollbar-thin scrollbar-gutter-stable overflow-y-auto overscroll-contain contain-content", className)}
    ref={attach}
    onWheel={(event) => { onWheel?.(event); if (!event.defaultPrevented && event.deltaY < 0) controller.pause() }}
    onKeyDown={(event) => {
      onKeyDown?.(event)
      if (!event.defaultPrevented && (["ArrowUp", "PageUp", "Home"].includes(event.key) || event.key === " " && event.shiftKey)) controller.pause()
    }}
    onTouchStart={(event) => { touchY.current = event.touches[0]?.clientY ?? null; onTouchStart?.(event) }}
    onTouchMove={(event) => {
      onTouchMove?.(event)
      const y = event.touches[0]?.clientY ?? null
      if (!event.defaultPrevented && y !== null && touchY.current !== null && y > touchY.current) controller.pause()
      touchY.current = y
    }}
    onPointerDown={(event) => {
      onPointerDown?.(event)
      const viewport = event.currentTarget
      const bounds = viewport.getBoundingClientRect()
      // Native scrollbar input is the remaining way to leave the live edge.
      if (!event.defaultPrevented && event.target === viewport && event.clientX >= bounds.left + viewport.clientLeft + viewport.clientWidth) controller.pause()
    }}
    onScroll={(event) => { controller.onScroll(); onScroll?.(event) }} {...props} />
}

function MessageScrollerContent({ className, ref, ...props }: React.ComponentProps<"div">) {
  const controller = useMessageScroller()
  const attach = React.useCallback((node: HTMLDivElement | null) => {
    controller.setContent(node)
    const cleanup = setRef(ref, node)
    return () => { cleanup(); controller.setContent(null) }
  }, [controller, ref])
  return <div ref={attach} role="log" aria-relevant="additions" data-slot="message-scroller-content"
    className={cn("flex h-max min-h-full flex-col gap-8", className)} {...props} />
}

function MessageScrollerButton({
  direction = "end", className, children, variant = "secondary", size = "icon-sm", onClick, ...props
}: React.ComponentProps<typeof Button> & { direction?: "start" | "end" }) {
  const controller = useMessageScroller()
  const scrollable = useMessageScrollerScrollable()
  const active = scrollable[direction]
  return <Button data-slot="message-scroller-button" data-direction={direction} data-active={active ? "true" : "false"}
    aria-hidden={!active} inert={!active} tabIndex={active ? props.tabIndex : -1} variant={variant} size={size}
    className={cn("absolute inset-s-1/2 -translate-x-1/2 border-border bg-background text-foreground transition-[translate,scale,opacity] duration-(--motion-normal) hover:bg-muted hover:text-foreground data-[active=false]:pointer-events-none data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=false]:duration-(--motion-slow) data-[active=false]:ease-[cubic-bezier(0.7,0,0.84,0)] data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100 data-[active=true]:ease-[cubic-bezier(0.23,1,0.32,1)] data-[direction=end]:bottom-4 data-[direction=end]:data-[active=false]:translate-y-full data-[direction=start]:top-4 data-[direction=start]:data-[active=false]:-translate-y-full rtl:translate-x-1/2 data-[direction=start]:[&_svg]:rotate-180", className)}
    onClick={(event) => {
      onClick?.(event)
      if (!event.defaultPrevented) {
        event.currentTarget.blur()
        if (direction === "end") controller.scrollToEnd()
        else controller.scrollToStart()
      }
    }} {...props}>
    {children ?? <><ArrowDownIcon /><span className="sr-only">{direction === "end" ? "Scroll to end" : "Scroll to start"}</span></>}
  </Button>
}

export { MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerButton, useMessageScroller, useMessageScrollerScrollable }
