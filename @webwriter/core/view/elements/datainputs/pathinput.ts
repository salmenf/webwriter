import { html, css, render, PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { SlInput } from "@shoelace-style/shoelace";
import { localized, msg } from "@lit/localize";

import { DataInput } from "./datainput";

const windowsPathPattern = /^(?<ParentPath>(?:[a-zA-Z]:|\\\\[^\<\>:"\/\\|?*]+\\[^\<\>:"\/\\|?*]+)\\(?:[^\<\>:"\/\\|?*]+\\)*)(?<BaseName>[^\<\>:"\/\\|?*]*?)/
const unixPathPattern = /[^\0]+/


type PickPathOptions = {
  defaultPath?: string,
  directory?: boolean,
  filters?: {name: string, extensions: string[]}[]
  multiple?: boolean,
  recursive?: boolean,
  title?: string
}

type PickPathHandler = (options?: PickPathOptions) => Promise<null | string | string[]>

@localized()
@customElement("ww-pathinput")
export class PathInput extends SlInput implements DataInput {

  @property({type: Boolean, attribute: true})
  inputDisabled: boolean = false

  @property({type: Boolean, attribute: true})
  recursive: boolean = false

  @property({type: Boolean, attribute: true})
  directory: boolean = false

  @property({reflect: true})
  autocomplete = "off"
  
  @property({reflect: true})
  autocorrect = "off" as const

  // @ts-ignore
  get pattern() {

    return ".*" // TODO: Issue with Windows regex on some systems?
    return window.WEBWRITER_ENVIRONMENT.os.name === "Windows"? windowsPathPattern.source: unixPathPattern.source
  }

  static styles = [SlInput.styles, css`
    ww-button {
      padding-right: 1ch;
    }

    :host([data-invalid]:not(:focus-within)) [part=input] {
      color: var(--sl-color-danger-600) !important;
    }

    :host([inputdisabled]) [part=input] {
      background: var(--sl-color-gray-100);
      margin-right: 1ch;
      cursor: not-allowed;
      font-style: italic;
    }
  `]

  handleClickPickPath = async () => {
    this.dispatchEvent(new CustomEvent("ww-pick-path", {bubbles: true, composed: true}))
  }

  firstUpdated(): void {
    const container = this.shadowRoot?.querySelector("slot[name=suffix]")
    container && container.children.length === 0 && render(this.Suffix(), container as HTMLElement)
  }

  protected updated(_changedProperties: PropertyValues): void {
    if(_changedProperties.has("inputDisabled")) {
      this.input.disabled = this.inputDisabled
    }
  }

  Suffix() {
    return html`<ww-button @click=${this.handleClickPickPath} title=${msg("Choose path from disk")} variant="icon" icon="folder-open"></ww-button>`
  }
}