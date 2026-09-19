import { useId, useMemo, useState } from "react";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

export type SearchComboboxOption = { value: string; label: string };

type SearchComboboxProps = {
  id: string;
  name: string;
  value: string;
  options: SearchComboboxOption[];
  onValueChange(value: string): void;
  allowCustom?: boolean;
  disabled?: boolean;
  placeholder?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
};

export function SearchCombobox({ id, name, value, options, onValueChange, allowCustom = false, disabled,
  placeholder, "aria-invalid": invalid, "aria-describedby": describedBy }: SearchComboboxProps) {
  const listId = `${useId()}-listbox`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find((option) => option.value === value);
  const visibleOptions = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return options;
    return options.filter((option) => `${option.label}\n${option.value}`.toLocaleLowerCase().includes(needle));
  }, [options, query]);
  const displayValue = allowCustom ? value : open ? query : selected ? `${selected.label} (${selected.value})` : "";

  const setOpenState = (next: boolean) => {
    setOpen(next);
    if (next) setQuery("");
  };
  const select = (next: string) => {
    onValueChange(next);
    setQuery("");
    setOpen(false);
  };
  const focusOption = (index: number) => {
    requestAnimationFrame(() => document.querySelectorAll<HTMLElement>(`#${CSS.escape(listId)} [role="option"]`)[index]?.focus());
  };

  return <PopoverPrimitive.Root open={open} onOpenChange={setOpenState}>
    <PopoverPrimitive.Anchor asChild>
      <div className="search-combobox">
        <Input id={id} name={name} role="combobox" autoComplete="off" spellCheck={false}
          aria-autocomplete="list" aria-expanded={open} aria-controls={listId} aria-invalid={invalid}
          aria-describedby={describedBy} placeholder={placeholder} value={displayValue} disabled={disabled}
          onClick={() => setOpenState(true)}
          onChange={(event) => {
            const next = event.target.value;
            setQuery(next);
            setOpen(true);
            if (allowCustom) onValueChange(next);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              if (!open) setOpenState(true);
              focusOption(0);
            } else if (event.key === "Enter" && !allowCustom && visibleOptions[0]) {
              event.preventDefault();
              select(visibleOptions[0].value);
            } else if (event.key === "Escape" && open) {
              event.preventDefault();
              setOpen(false);
            }
          }} />
        <PopoverPrimitive.Trigger asChild>
          <Button type="button" variant="ghost" size="icon" className="search-combobox-trigger"
            disabled={disabled} aria-label={name === "providerId" ? "展开 Provider 候选" : "展开模型候选"}>
            <ChevronsUpDownIcon aria-hidden="true" />
          </Button>
        </PopoverPrimitive.Trigger>
      </div>
    </PopoverPrimitive.Anchor>
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content className="search-combobox-content" align="start" sideOffset={4}
        onOpenAutoFocus={(event) => event.preventDefault()}>
        <div id={listId} role="listbox" aria-label={name === "providerId" ? "Provider 候选" : "模型候选"}>
          {visibleOptions.map((option, index) => <button key={option.value} type="button" role="option"
            aria-selected={option.value === value} className="search-combobox-option" onClick={() => select(option.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const offset = event.key === "ArrowDown" ? 1 : -1;
                focusOption((index + offset + visibleOptions.length) % visibleOptions.length);
              } else if (event.key === "Home" || event.key === "End") {
                event.preventDefault();
                focusOption(event.key === "Home" ? 0 : visibleOptions.length - 1);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setOpen(false);
              }
            }}>
            <span className="search-combobox-option-text"><strong>{option.label}</strong><small>{option.value}</small></span>
            {option.value === value && <CheckIcon aria-hidden="true" />}
          </button>)}
          {!visibleOptions.length && <p className="search-combobox-empty" role="status">没有匹配项</p>}
        </div>
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  </PopoverPrimitive.Root>;
}
