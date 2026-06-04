import * as React from "react";

/**
 * framer-mock.tsx
 * A lightweight, self-contained mock of the Framer package.
 * Allows components using the "framer" package to build and run seamlessly
 * in standard standard-react Vite dev servers without module resolution issues.
 * 
 * [SAFETY RULES]: Track errors, keep comments tiny, clean, and touch only needed code.
 */

export const ControlType = {
  String: "string",
  Number: "number",
  Boolean: "boolean",
  Enum: "enum",
  Color: "color",
  Image: "image",
  File: "file",
  ComponentInstance: "componentinstance",
  Array: "array",
  Object: "object",
  Transition: "transition",
};

export const RenderTarget = {
  current: "canvas",
  canvas: "canvas",
  preview: "preview",
  export: "export",
};

export function addPropertyControls(component: any, controls: any) {
  // Tactile no-op for component properties outside Framer Studio editor
  return component;
}

export function useIsStaticRenderer() {
  return false;
}

export const Frame = React.forwardRef<HTMLDivElement, any>((props, ref) => {
  const { children, ...rest } = props;
  return (
    <div ref={ref} {...rest}>
      {children}
    </div>
  );
});

Frame.displayName = "Frame";

export function addFonts() {}

export const ComponentViewportProvider = (props: any) => {
  return <>{props.children}</>;
};

export function cx(...args: any[]) {
  return args.filter(Boolean).join(" ");
}

export function CycleVariantState() {}

export function getFonts() {
  return [];
}

export function getFontsFromSharedStyle() {
  return [];
}

export function getLoadingLazyAtYPosition() {
  return false;
}

export const Image = React.forwardRef<HTMLImageElement, any>((props, ref) => {
  return <img ref={ref} {...props} />;
});
Image.displayName = "Image";

export const Link = React.forwardRef<HTMLAnchorElement, any>((props, ref) => {
  return <a ref={ref} {...props} />;
});
Link.displayName = "Link";

export const RichText = React.forwardRef<HTMLDivElement, any>((props, ref) => {
  return <div ref={ref} {...props} />;
});
RichText.displayName = "RichText";

export function useComponentViewport() {
  return { width: 400, height: 600 };
}

export function useLocaleInfo() {
  return { locale: "en", direction: "ltr" };
}

export function useVariantState() {
  return ["default", () => {}];
}

export function withCSS(Component: any) {
  return Component;
}

export function Data(initial: any) {
  return initial;
}

export function useObserveData(data: any) {
  return data;
}
