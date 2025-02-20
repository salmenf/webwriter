import { localized, msg } from "@lit/localize"
import { SlCheckbox, SlSelect, SlTabGroup } from "@shoelace-style/shoelace"
import { html, css, LitElement, TemplateResult } from "lit"
import { customElement, property, query } from "lit/decorators.js"
import { ZodBoolean, ZodLiteral, ZodSchema, ZodUnion } from "zod"

import { Settings, SettingSpec } from "#viewmodel"

@localized()
@customElement("ww-configurator")
export class Configurator extends LitElement {

  @property({attribute: false})
  specs: Settings

  @property({attribute: false})
  specLabels: Record<string, string>

  @property({attribute: false})
  values: Record<string, Record<string, any>>

  @property()
  activeTab: string | null 

  @property({type: String})
  confirmingOption: string | undefined

  static get styles() {
    return css`
      :host {
        height: 100%;
        display: block;
      }

      sl-tab-group {
        height: 100%;
        overflow-x: hidden;
      }

      sl-tab-group::part(nav) {
        position: sticky;
        top: 0;
        left: 0;
        background: white;
        z-index: 100;
      }

      sl-tab::part(base) {
        padding: var(--sl-spacing-small);
      }

      sl-tab-group::part(base) {
        height: 100%;
      }

      sl-tab::part(base) {
        padding-right: 2ch;
      }

      sl-tab-group::part(body) {
        padding-top: 1rem;
        overflow-y: auto;
        height: 100%;
      }

      .setting-group[active] {
        height: 100%;
      }

      sl-tab-group {
        height: 100%;
      }

      sl-tab-panel::part(base) {
        padding: var(--sl-spacing-small);
        height: 100%;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }

      sl-tab-panel[name=pre-a]::part(base) {
        padding: 0;
      }

      label {
        display: inline-flex;
        gap: 1ch;
      }

      .help-text {
        margin-top: var(--sl-spacing-3x-small);
        font-size: var(--sl-font-size-small);
        color: var(--sl-color-neutral-500);
      }

      #post-tabs {
        display: flex;
        margin-left: auto;
        height: 100%;
        align-items: center;
        gap: 1rem;
        margin-right: var(--sl-spacing-small);
      }

      label {
        cursor: pointer;
      }
    `
  }

  SettingGroup(key: string, specs: Record<string, SettingSpec>, values: Record<string, any>, onChange: (groupKey: string, key: string, value: any) => any, label: string) {
    const keys = Object.keys(specs).filter(k => !specs[k]?.hidden)
    return keys.length === 0? null: html`
      <sl-tab slot="nav" panel=${key}>
        ${label}
      </sl-tab>
      <sl-tab-panel class="setting-group" name=${key}>
        ${keys.map(k => this.Setting(key, k, specs[k].schema, values[k], onChange, specs[k].label ?? k, specs[k].confirmation))}
      </sl-tab-panel>
    `
  }

  Setting(groupKey: string, key: string, schema: ZodSchema, value: any, onChange: (groupKey: string, key: string, value: any) => any, label: string, confirmation?: TemplateResult) {
    const id = groupKey + "." + key
    if(schema instanceof ZodUnion && schema._def.options.every((opt: ZodSchema) => opt instanceof ZodLiteral)) {
      const options = schema._def.options as ZodLiteral<any>[]
      return html`<sl-select
        id=${id} value=${value} @sl-change=${(e: Event) => onChange(groupKey, key, (e.target as SlSelect).value)}>
        <label slot="label" for=${id}>
          ${key === "locale" && html`<sl-icon name="language"></sl-icon>`}
          ${label}
        </label>
        <span slot="help-text">${schema.description}</span>
        ${options.map(opt => html`
          <sl-option value=${String(opt.value)}>
            ${opt.description ?? String(opt.value)}
          </sl-option>
        `)}
      </sl-select>`
    }
    else if(schema instanceof ZodBoolean) {
      return html`<sl-checkbox
        id=${id}
        ?checked=${value}
        @sl-change=${(e: Event) => {
          onChange(groupKey, key, (e.target as SlCheckbox).checked)
        }}
        @click=${(e: PointerEvent) => {
          const checked = (this.shadowRoot!.getElementById(id) as SlCheckbox).checked
          console.log(checked)
          if(confirmation && !checked) {
            e.preventDefault()
            this.confirmingOption = id
          }
          else if(confirmation && checked) {
            e.preventDefault()
            setTimeout(() => {
              (this.shadowRoot!.getElementById(id) as SlCheckbox).checked = false
              onChange(groupKey, key, false)
            })
          }
        }}
      >
        <label for=${id}>${label}</label><br>
        <span class="help-text">${schema.description}</span>
      </sl-checkbox>
      ${!confirmation? null: html`
        <sl-dialog label=${label} ?open=${id === this.confirmingOption} @sl-hide=${() => this.confirmingOption = undefined}>
          ${confirmation}
          <sl-button variant="primary" style="float: right; margin-left: 0.5ch;" @click=${() => {
            this.confirmingOption = undefined;
            (this.shadowRoot!.getElementById(id) as SlCheckbox).checked = true
            onChange(groupKey, key, true)
            this.requestUpdate()
          }}>${msg("Confirm")}</sl-button>
          <sl-button variant="neutral" style="float: right" @click=${() => this.confirmingOption = undefined}>${msg("Cancel")}</sl-button>
        </sl-dialog>
      `}`
    }
    else {
      return html`${key}`
    }
  }

  emitChange = (groupKey: string, key: string, value: any) => this.dispatchEvent(new CustomEvent(
    "ww-change",
    {detail: {groupKey, key, value}}
  ))

  @query("sl-tab-group") tabGroup: SlTabGroup

  render() {
    console.log(this.specs)
    const keys = Object.keys(this.specs)
    return html`
      <sl-tab-group>
        ${keys.map(k => this.SettingGroup(k, this.specs[k], this.values[k], this.emitChange, this.specLabels[k]))}
        <sl-tab slot="nav" panel="post-a" @click=${() => this.tabGroup.show("post-a")}>
          <slot name="post-tab-a"></slot>
        </sl-tab>
        <sl-tab-panel name="post-a">
          <slot name="post-tab-panel-a"></slot>
        </sl-tab-panel>
        <sl-tab slot="nav" panel="post-b" @click=${() => this.tabGroup.show("post-b")}>
          <slot name="post-tab-b"></slot>
        </sl-tab>
        <sl-tab-panel name="post-b">
          <slot name="post-tab-panel-b"></slot>
        </sl-tab-panel>
        <slot id="post-tabs" slot="nav" name="post-tabs"></slot>
      </sl-tab-group>
    `
  }
}