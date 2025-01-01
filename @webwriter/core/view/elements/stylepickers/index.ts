export * from "./alignmentpicker"
export * from "./borderpicker"
export * from "./fontpicker"
export * from "./lineheightpicker"
export * from "./backgroundpicker"
export * from "./boxpicker"

import {LitElement, html} from "lit"
import {property} from "lit/decorators.js"
import { CSSPropertySpecs } from "../../../model/schemas/cssvaluedefinition.data"
import { filterObject } from "../../../model/utility"
import { CSSValueDefinition, ICSSValueDefinition } from "../../../model/schemas/cssvaluedefinition"
import { ifDefined } from "lit/directives/if-defined.js"


export function StyleForm<T extends readonly (keyof CSSPropertySpecs)[]>(superClass: typeof LitElement, keys: T, allSpecs=CSSPropertySpecs) {
  return class extends superClass {

    static formAssociated = true
    protected static stylePropertySpecs = filterObject(allSpecs, k => k in keys) as unknown as Pick<typeof allSpecs, T[number]>
  
    protected _internals: ElementInternals
    protected _value: {[Property in T[number]]: string}
  
    constructor() {
      super()
      this._internals = this.attachInternals()
    }
  
    get value() {
      return this._value
    }
  
    set value(v: typeof this._value) {
      const oldValue = this._value
      this._value = v
      const formData = Object.entries(v).reduce((acc: FormData, [k, v]) => {
        acc.set(k, v as any)
        return acc
      }, new FormData())
      this._internals.setFormValue(formData)
      this.requestUpdate("value", oldValue)
    }
  
    setValueField(k: T[number], v: string) {
      const oldValue = this._value[k]
      this._value[k] = v
      this.requestUpdate(k, oldValue)
    }
  
    public checkValidity(): boolean {
      return this._internals.checkValidity();
    }
    
    public reportValidity(): boolean {
      return this._internals.reportValidity();
    }
    
    public get validity(): ValidityState {
      return this._internals.validity;
    }
    
    public get validationMessage(): string {
      return this._internals.validationMessage;
    }

    updateValidity(newValue: string) {
      
    }
  }
}


/** Input a CSS value of the specified type. If `syntax` is set, it is used to provide an appropriate input and validation. Else, if `syntax` is not set, but `name` is a known CSS property name, automatically use that property's syntax. Otherwise, fall back to a normal text input. */
export class StyleInput extends LitElement {
  static formAssociated = true
  protected _internals: ElementInternals

  constructor() {
    super()
    this._internals = this.attachInternals()
  }

  @property({type: String, attribute: true, reflect: true})
  name: string

  @property({type: String, attribute: true, reflect: true})
  syntax: string

  @property({type: String, attribute: true, reflect: true})
  label: string

  _value: string

  get value() {
    return this._value
  }

  @property({type: String, attribute: true})
  set value(v: typeof this._value) {
    const oldValue = this._value
    this._value = v
    const formData = Object.entries(v).reduce((acc: FormData, [k, v]) => {
      acc.set(k, v as any)
      return acc
    }, new FormData())
    this._internals.setFormValue(formData)
    this.requestUpdate("value", oldValue)
  }

  @property({attribute: false, state: true})
  private pos = 0

  get valueDefinition() {
    return (this.syntax? CSSValueDefinition.parse(this.syntax): null) ?? CSSValueDefinition.CSSPropertySpecs[this.name as keyof typeof CSSValueDefinition.CSSPropertySpecs].syntaxTree ?? undefined
  }

  public checkValidity(): boolean {
    return this._internals.checkValidity();
  }
  
  public reportValidity(): boolean {
    return this._internals.reportValidity();
  }
  
  public get validity(): ValidityState {
    return this._internals.validity;
  }
  
  public get validationMessage(): string {
    return this._internals.validationMessage;
  }



  render() {
    // 
    return 
  }
}

class StylePropertyField extends LitElement {

  static complexTypes = ["Alternation", "Subset", "OrderedSequence", "UnorderedSequence"] as const satisfies ICSSValueDefinition["type"][]

  static unitPattern = {
    "custom-ident": /abc/,
    "dashed-ident": /abc/
  }

  static unitMin = {
    "resolution": "0",
    "flex": "0"
  } as const satisfies Record<string, string>

  static unitMax = {

  } as const satisfies Record<string, string>

  static unitStep = {
    "integer": "1"
  } as const satisfies Record<string, string>

  static unitSuffixes = {
    "percentage": ["%"],
    "length": ["em", "rem", "ex", "rex", "cap", "rcap", "ch", "rch", "ic", "ric", "lh", "rlh", "vw", "vh", "vi", "vb", "vmin", "vmax", "cm", "mm", "Q", "in", "pt", "pc", "px"],
    "angle": ["deg", "grad", "rad", "turn"],
    "time": ["s", "ms"],
    "frequency": ["Hz", "kHz"],
    "resolution": ["dpi", "dpcm", "dppx"],
    "length-percentage": ["%", "em", "rem", "ex", "rex", "cap", "rcap", "ch", "rch", "ic", "ric", "lh", "rlh", "vw", "vh", "vi", "vb", "vmin", "vmax", "cm", "mm", "Q", "in", "pt", "pc", "px"],
    "frequency-percentage": ["%", "Hz", "kHz"],
    "angle-percentage": ["%", "deg", "grad", "rad", "turn"],
    "time-percentage": ["%", "s", "ms"],
    "flex": ["fr"],
    "alpha-value": ["", "%"],
    "hue": ["", "deg", "grad", "rad", "turn"],
  } as const satisfies Record<string, string[]>

  @property({type: String, attribute: true, reflect: true})
  name: string

  @property({type: String, attribute: true, reflect: true})
  syntax: string

  @property({type: String, attribute: true, reflect: true})
  label: string

  get valueDefinition() {
    return (this.syntax? CSSValueDefinition.parse(this.syntax): null) ?? CSSValueDefinition.CSSPropertySpecs[this.name as keyof typeof CSSValueDefinition.CSSPropertySpecs].syntaxTree ?? undefined
  }

  @property({type: String, attribute: true})
  value: string


  Select(def: ICSSValueDefinition | undefined = this.valueDefinition) {
    if(!def) {
      return html`<sl-input type="text"></sl-input>`
    }
    else if(def.type === "Literal") {
      return html`<span>${def.content}</span>`
    }
    else if(def.type === "DataType" && ["custom-ident", "dashed-ident", "string"].includes(def.content)) {
      return html`<sl-input
        type="text"
        pattern=${ifDefined((StylePropertyField.unitPattern as any)[def.content])}
      ></sl-input>`
    }
    else if(def.type === "DataType" && def.content === "url") {
      return html`<sl-input
        type="url"
        pattern=${ifDefined((StylePropertyField.unitPattern as any)[def.content])}
      ></sl-input>`
    }
    else if(def.type === "DataType" && ["integer", "number", "percentage", "flex", "length", "angle", "time", "frequency", "resolution", "length-percentage", "frequency-percentage", "angle-percentage", "time-percentage", "hue"].includes(def.content)) {
      return html`<sl-input type="number"></sl-input>`
    }
    else if(def.type === "DataType" && def.content === "alpha-value") {
      return html`<sl-input type="number"></sl-input>`
    }
    else if(def.type === "DataType" && def.content === "ratio") {
      return html`<sl-input type="number"></sl-input> / <sl-input type="number"></sl-input>`
    }
    else if(def.type === "DataType" && def.content === "color") {
      return html`<sl-color-picker></sl-color-picker>`
    }
    else if(def.type === "DataType" && def.content === "image") {
      return html`<ww-urlfileinput></ww-urlfileinput>` // TODO gradients
    }
    else if(def.type === "DataType" && def.content === "position") {
      return html`<ww-combobox></ww-combobox>`
    }
  }

  // State machine approach:
  // construct state machine from 

  render() {
    return html`
      <div>${this.label ?? this.name}</div>
      ${this.Select()}
      <div>
        <div>initial</div>
        <div>inherit</div>
        <div>revert</div>
        <div>unset</div>
      </div>
    `
  }
}