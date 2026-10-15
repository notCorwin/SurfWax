import { useEffect, useMemo, useRef, useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useVirtualizer } from "@tanstack/react-virtual";

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
  const selected = options.find((option) => option.value === value);
  const displayValue = allowCustom ? value : selected ? `${selected.label} (${selected.value})` : "";
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState(displayValue);
  const container = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const visibleOptions = useMemo(() => {
    const query = inputValue.trim().toLocaleLowerCase();
    if (!query) return options;
    return options.filter((option) => `${option.label}\n${option.value}`.toLocaleLowerCase().includes(query));
  }, [inputValue, options]);
  const virtualizer = useVirtualizer({ count: visibleOptions.length, getScrollElement: () => list.current,
    estimateSize: () => 48, overscan: 8 });

  useEffect(() => {
    if (!open) setInputValue(displayValue);
  }, [displayValue, open]);
  useEffect(() => {
    if (open && visibleOptions.length) virtualizer.scrollToIndex(0);
  }, [inputValue, open, visibleOptions.length, virtualizer]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress, true);
  }, [open]);

  return (
    <Combobox.Root
      items={visibleOptions.map((option) => option.value)}
      name={name}
      value={value || null}
      inputValue={inputValue}
      open={open}
      inline={open}
      virtualized
      disabled={disabled}
      autoHighlight
      onItemHighlighted={(itemValue, details) => {
        if (details.reason !== "keyboard" || itemValue === undefined) return;
        const index = visibleOptions.findIndex((option) => option.value === itemValue);
        if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
      }}
      itemToStringLabel={(itemValue) => {
        const option = options.find((item) => item.value === itemValue);
        return allowCustom ? itemValue : option ? `${option.label} (${option.value})` : itemValue;
      }}
      onOpenChange={(next, details) => {
        setOpen(next);
        if (next) setInputValue("");
        else if (details.reason !== "item-press") setInputValue(displayValue);
      }}
      onInputValueChange={(next, details) => {
        setInputValue(next);
        if (allowCustom && details.reason === "input-change") onValueChange(next);
      }}
      onValueChange={(next) => {
        if (next === null) return;
        onValueChange(next);
        const option = options.find((item) => item.value === next);
        setInputValue(allowCustom ? next : option ? `${option.label} (${option.value})` : next);
        setOpen(false);
      }}
    >
      <div ref={container} className="search-combobox rounded-md" data-focus-group="">
        <Combobox.InputGroup>
          <Combobox.Input
            render={<Input />}
            id={id}
            data-focus-delegate=""
            autoComplete="off"
            spellCheck={false}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            placeholder={placeholder}
          />
          <Combobox.Trigger
            render={<Button type="button" variant="ghost" size="icon" />}
            className="search-combobox-trigger"
            aria-label={name === "providerId" ? "展开 Provider 候选" : "展开模型候选"}
          >
            <ChevronsUpDownIcon aria-hidden="true" />
          </Combobox.Trigger>
        </Combobox.InputGroup>
        {open && <div className="search-combobox-content">
            <Combobox.Empty className="search-combobox-empty">没有匹配项</Combobox.Empty>
            <Combobox.List ref={list} className="search-combobox-list">
              <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((row) => {
                const option = visibleOptions[row.index];
                if (!option) return null;
                return <Combobox.Item key={option.value} value={option.value} index={row.index} className="search-combobox-option absolute left-0"
                  style={{ transform: `translateY(${row.start}px)` }}>
                    <span className="search-combobox-option-text"><strong>{option.label}</strong><small>{option.value}</small></span>
                    <Combobox.ItemIndicator><CheckIcon aria-hidden="true" /></Combobox.ItemIndicator>
                  </Combobox.Item>;
              })}
              </div>
            </Combobox.List>
        </div>}
      </div>
    </Combobox.Root>
  );
}
