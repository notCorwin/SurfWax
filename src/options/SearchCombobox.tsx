import { useEffect, useMemo, useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
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
  const values = useMemo(() => options.map((option) => option.value), [options]);
  const selected = options.find((option) => option.value === value);
  const displayValue = allowCustom ? value : selected ? `${selected.label} (${selected.value})` : "";
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState(displayValue);

  useEffect(() => {
    if (!open) setInputValue(displayValue);
  }, [displayValue, open]);

  return (
    <Combobox.Root
      items={values}
      name={name}
      value={value || null}
      inputValue={inputValue}
      open={open}
      disabled={disabled}
      autoHighlight
      itemToStringLabel={(itemValue) => {
        const option = options.find((item) => item.value === itemValue);
        return allowCustom ? itemValue : option ? `${option.label} (${option.value})` : itemValue;
      }}
      filter={(itemValue, query) => {
        const option = options.find((item) => item.value === itemValue);
        return `${option?.label ?? ""}\n${itemValue}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
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
      }}
    >
      <Combobox.InputGroup className="search-combobox rounded-md" data-focus-group="">
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
      <Combobox.Portal>
        <Combobox.Positioner className="z-50 outline-none" align="start" sideOffset={4} collisionPadding={8}>
          <Combobox.Popup className="search-combobox-content origin-[var(--transform-origin)] transition-[transform,opacity] duration-(--motion-fast) data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0">
            <Combobox.Empty className="search-combobox-empty">没有匹配项</Combobox.Empty>
            <Combobox.List>
              {(itemValue: string) => {
                const option = options.find((item) => item.value === itemValue);
                if (!option) return null;
                return (
                  <Combobox.Item key={option.value} value={option.value} className="search-combobox-option">
                    <span className="search-combobox-option-text"><strong>{option.label}</strong><small>{option.value}</small></span>
                    <Combobox.ItemIndicator><CheckIcon aria-hidden="true" /></Combobox.ItemIndicator>
                  </Combobox.Item>
                );
              }}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
