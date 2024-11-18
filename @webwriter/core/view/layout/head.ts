import { localized, msg } from "@lit/localize";
import { LitElement, html, css, PropertyValueMap } from "lit";
import {
  customElement,
  property,
  query,
  queryAssignedElements,
} from "lit/decorators.js";
import { spreadProps } from "@open-wc/lit-helpers";

import { Command } from "../../viewmodel";

const PROTOCOL_ICONS = {
  file: "folder",
  http: "cloud",
  https: "cloud",
};

@localized()
@customElement("ww-head")
export class Head extends LitElement {
  @property({ type: String, attribute: false })
  filename?: string | URL | FileSystemFileHandle;

  @property({ type: Boolean, attribute: true, reflect: true })
  pendingChanges: boolean = false;

  @property({ type: String, attribute: true, reflect: true })
  ioState:
    | "idle"
    | "loading"
    | "saving"
    | "loadingPreview"
    | "loadingGrammar"
    | "grammarActive" = "idle";

  @property({ type: Array, attribute: false })
  documentCommands: Command[] = [];

  get emptyFilename() {
    return msg("Unsaved File");
  }

  static styles = css`
    :host {
      display: flex;
      flex-direction: row;
      justify-content: center;
      --icon-size: 24px;
      height: 50px;
      width: 100%;
      align-items: center;
      color: var(--sl-color-gray-700);
      gap: 0.625ch;
    }

    #filename {
      font-weight: bold;
      user-select: none;
      display: inline flex;
      flex-direction: row;
      align-items: center;
      overflow: hidden;
    }

    #filename :first-child {
      display: flex;
      align-items: center;
      gap: 0.25ch;
      overflow: hidden;
      text-wrap: nowrap;
    }

    #pending-indicator {
      visibility: hidden;
      font-size: 1.5rem;
      flex-shrink: 0;
      display: block;
    }

    :host(:is([pendingChanges], [iostate="loading"], [iostate="saving"]))
      #pending-indicator {
      visibility: visible;
    }

    #pending-indicator sl-spinner {
      font-size: 0.7rem;
      --track-width: 3px;
      --indicator-color: var(--sl-color-gray-800);
      transform: translateY(-50%);
    }

    #document-commands {
      --icon-size: 20px;
      flex-shrink: 0;
    }
  `;

  IconicURL = () => {
    let iconName, filename, prettyFilename;
    if (!this.filename) {
      filename = this.emptyFilename;
    } else if (this.filename instanceof URL) {
      iconName = (PROTOCOL_ICONS as any)[this.filename.protocol.slice(0, -1)];
      filename =
        this.filename.searchParams.get("filename") ??
        this.filename.pathname
          .slice(this.filename.pathname.lastIndexOf("/") + 1)
          .split("#")[0];
      prettyFilename = filename.replace(/\_[a-zA-Z0-9]{10}\.[a-zA-Z0-9]+/, "");
    } else if (this.filename instanceof FileSystemFileHandle) {
      iconName = (PROTOCOL_ICONS as any).file;
      filename = this.filename.name;
      prettyFilename = filename.replace(/\_[a-zA-Z0-9]{10}\.[a-zA-Z0-9]+/, "");
    } else {
      filename = this.filename;
    }
    return html`
      ${this.filename ? html`<sl-icon name=${iconName}></sl-icon>` : null}
      <span id="filename">
        <span title=${filename}>${prettyFilename ?? filename}</span>
        <span
          title=${msg("This explorable has unsaved changes.")}
          id="pending-indicator"
          >${this.ioState === "idle" || this.ioState === "grammarActive"
            ? "*"
            : html`<sl-spinner></sl-spinner>`}</span
        >
      </span>
    `;
  };

  render() {
    return html`
      ${this.IconicURL()}
      <div id="document-commands">
        ${this.documentCommands.map(
          (v) => html`<ww-button
            variant="icon"
            ${spreadProps(v.toObject())}
            @click=${() => v.run()}
          ></ww-button>`
        )}
      </div>
      <slot></slot>
    `;
  }
}
