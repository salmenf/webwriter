# Guide: Creating a package

## Introduction
WebWriter uses [npm packages](https://docs.npmjs.com/packages-and-modules) to provide an easy way of extending the authoring tool with new widgets. WebWriter will discover any package published on npm ([read more about npm here](https://docs.npmjs.com/about-npm)) if it is tagged with the keyword `webwriter`.

## Prerequisites
You have a text editor / IDE of your choice installed on your Windows/Mac/Linux system. You also have [nodejs including npm](https://nodejs.org/) installed, alternatively [yarn](https://yarnpkg.com/). You also have a user account on npmjs.com (sign up for free [here](https://docs.npmjs.com/creating-a-new-npm-user-account)).

## Creating your package

### Step 1: Creating your package directory
Create a new directory with the name you want for your package. The package name must be both a [valid custom element tag (one or more characters followed by a dash `-` and zero or more characters)](https://html.spec.whatwg.org/multipage/custom-elements.html#valid-custom-element-name) and an available package name on `npm` (check this by [searching npm](https://www.npmjs.com/)). We recommend using the prefix `ww-`: For example, a package name could be `ww-coolwidget`.
```sh
mkdir ww-coolwidget
```

### Step 2: Creating your main file
Create your main file in your package directory (e.g. `ww-coolwidget/index.js` if using JS or `ww-coolwidget/index.ts` if using TypeScript).

After this step, your directory should look similar to this:
```
ww-coolwidget
  index.ts
```

### Step 3: Initializing your package
Use npm to initialize the package. In the interactive prompt, the package name should be left as the directory name from step 1 (default), the entry point should be your main file from step 2, and one of the keywords *must* be `webwriter`.

```sh
cd ww-coolwidget
npm init
```

After this step, your directory should look similar to this:
```
ww-coolwidget
  index.ts
  package.json
```

### Step 4: Implementing your widget
Implement your widget in your main file from step 2 ([guide here](./creatingwidgets.md)). *If you just want to test the package for now and implement later, skip this step.*

### Step 5: Publishing your package
Publish your library with npm. Make sure you do not include sensitive data (not an issue if you only followed this guide).

```sh
npm publish
```

## Testing your package
First off, your package should be available on [`npm`, try searching for it](https://www.npmjs.com/). If it is, start WebWriter, then open the Package Manager. Under 'Available', your package can be installed.

## Notes & Troubleshooting
- When publishing a new version, you need to increment the version in your `package.json`, as well.
- If your package shows up on [npmjs.com](npmjs.com) but not in the Package Manager, make sure you added the `webwriter` keyword to your `package.json`.
- Of course, the `package.json` file can also be created manually without `npm init` if you prefer.