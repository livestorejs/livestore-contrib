//! `#[derive(Event)]`: defines a `LiveStore` event from its args struct, so the name, the args type
//! and the args schema are written once.

use proc_macro::TokenStream;
use proc_macro2::Span;
use quote::quote;
use syn::{Data, DeriveInput, Error, Fields, LitStr, parse_macro_input};

/// Implements `livestore_schema::Event` for an args struct.
///
/// ```ignore
/// #[derive(Event, Serialize, Deserialize)]
/// #[event(name = "v1.TodoCreated")]
/// struct TodoCreated { id: String, text: String }
/// ```
///
/// Struct attributes: `name = "..."` (required), `client_only`, `deprecated = "reason"`.
/// Field attribute: `deprecated = "reason"`. The args schema follows the serde names, so
/// `#[serde(rename_all = "camelCase")]` and `#[serde(rename = "...")]` are respected.
#[proc_macro_derive(Event, attributes(event))]
pub fn derive_event(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    expand(&input)
        .unwrap_or_else(Error::into_compile_error)
        .into()
}

fn expand(input: &DeriveInput) -> syn::Result<proc_macro2::TokenStream> {
    let ty = &input.ident;
    if !input.generics.params.is_empty() {
        return Err(Error::new_spanned(
            &input.generics,
            "an event cannot be generic",
        ));
    }
    let Data::Struct(data) = &input.data else {
        return Err(Error::new_spanned(ty, "an event must be a struct"));
    };

    let mut name = None;
    let mut client_only = false;
    let mut deprecated = None;
    for attr in input.attrs.iter().filter(|a| a.path().is_ident("event")) {
        attr.parse_nested_meta(|meta| {
            if meta.path.is_ident("name") {
                name = Some(meta.value()?.parse::<LitStr>()?);
            } else if meta.path.is_ident("client_only") {
                client_only = true;
            } else if meta.path.is_ident("deprecated") {
                deprecated = Some(meta.value()?.parse::<LitStr>()?);
            } else {
                return Err(meta.error("expected `name`, `client_only` or `deprecated`"));
            }
            Ok(())
        })?;
    }
    let name =
        name.ok_or_else(|| Error::new(Span::call_site(), "missing `#[event(name = \"...\")]`"))?;
    let rename_all = serde_rename_all(&input.attrs)?;

    let mut deprecated_fields = Vec::new();
    let schema = match &data.fields {
        Fields::Unit => quote!(::livestore_schema::value_schema::void()),
        Fields::Unnamed(f) => {
            return Err(Error::new_spanned(f, "event args must have named fields"));
        }
        Fields::Named(fields) => {
            let mut entries = Vec::new();
            for field in &fields.named {
                let ident = field.ident.as_ref().expect("named field");
                let wire = match serde_rename(&field.attrs)? {
                    Some(n) => n,
                    None => rename_all.apply(ident.to_string().trim_start_matches("r#")),
                };
                let field_ty = &field.ty;
                entries.push(quote! {
                    (#wire, <#field_ty as ::livestore_schema::SchemaType>::schema())
                });
                for attr in field.attrs.iter().filter(|a| a.path().is_ident("event")) {
                    attr.parse_nested_meta(|meta| {
                        if meta.path.is_ident("deprecated") {
                            let reason = meta.value()?.parse::<LitStr>()?;
                            deprecated_fields.push(quote!((#wire, #reason)));
                            Ok(())
                        } else {
                            Err(meta.error("expected `deprecated`"))
                        }
                    })?;
                }
            }
            quote!(::livestore_schema::value_schema::struct_([#(#entries),*]))
        }
    };
    Ok(event_impl(
        ty,
        &name,
        client_only,
        deprecated.as_ref(),
        &schema,
        &deprecated_fields,
    ))
}

fn event_impl(
    ty: &syn::Ident,
    name: &LitStr,
    client_only: bool,
    deprecated: Option<&LitStr>,
    schema: &proc_macro2::TokenStream,
    deprecated_fields: &[proc_macro2::TokenStream],
) -> proc_macro2::TokenStream {
    let deprecated = deprecated.map_or_else(
        || quote!(::std::option::Option::None),
        |reason| quote!(::std::option::Option::Some(#reason)),
    );
    quote! {
        impl ::livestore_schema::Event for #ty {
            const NAME: &'static str = #name;

            fn def() -> &'static ::livestore_schema::EventDef<Self> {
                static DEF: ::std::sync::LazyLock<::livestore_schema::EventDef<#ty>> =
                    ::std::sync::LazyLock::new(|| {
                        ::livestore_schema::EventDef::__derive(
                            #name,
                            #client_only,
                            #schema,
                            #deprecated,
                            &[#(#deprecated_fields),*],
                        )
                    });
                &DEF
            }
        }
    }
}

enum RenameAll {
    None,
    CamelCase,
    SnakeCase,
}

impl RenameAll {
    fn apply(&self, field: &str) -> String {
        match self {
            RenameAll::None | RenameAll::SnakeCase => field.to_owned(),
            RenameAll::CamelCase => {
                let mut out = String::new();
                let mut upper = false;
                for c in field.chars() {
                    if c == '_' {
                        upper = true;
                    } else if upper {
                        out.extend(c.to_uppercase());
                        upper = false;
                    } else {
                        out.push(c);
                    }
                }
                out
            }
        }
    }
}

fn serde_rename_all(attrs: &[syn::Attribute]) -> syn::Result<RenameAll> {
    let mut result = RenameAll::None;
    for attr in attrs.iter().filter(|a| a.path().is_ident("serde")) {
        attr.parse_nested_meta(|meta| {
            if meta.path.is_ident("rename_all") {
                let value = meta.value()?.parse::<LitStr>()?;
                result = match value.value().as_str() {
                    "camelCase" => RenameAll::CamelCase,
                    "snake_case" => RenameAll::SnakeCase,
                    _ => {
                        return Err(Error::new_spanned(
                            value,
                            "`#[derive(Event)]` supports only camelCase and snake_case",
                        ));
                    }
                };
            } else if meta.input.peek(syn::Token![=]) {
                meta.value()?.parse::<proc_macro2::TokenStream>()?;
            }
            Ok(())
        })?;
    }
    Ok(result)
}

fn serde_rename(attrs: &[syn::Attribute]) -> syn::Result<Option<String>> {
    let mut result = None;
    for attr in attrs.iter().filter(|a| a.path().is_ident("serde")) {
        attr.parse_nested_meta(|meta| {
            if meta.path.is_ident("rename") {
                result = Some(meta.value()?.parse::<LitStr>()?.value());
            } else if meta.input.peek(syn::Token![=]) {
                meta.value()?.parse::<proc_macro2::TokenStream>()?;
            } else if meta.input.peek(syn::token::Paren) {
                meta.parse_nested_meta(|inner| {
                    if inner.input.peek(syn::Token![=]) {
                        inner.value()?.parse::<proc_macro2::TokenStream>()?;
                    }
                    Ok(())
                })?;
            }
            Ok(())
        })?;
    }
    Ok(result)
}
