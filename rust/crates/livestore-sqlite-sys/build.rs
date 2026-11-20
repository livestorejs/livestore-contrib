use std::{env, path::PathBuf};

/// wa-sqlite `WASQLITE_DEFINES` + `WASQLITE_EXTRA_DEFINES` of the build LiveStore loads
/// (packages/@livestore/wa-sqlite/{Makefile,flake.nix}).
const WASQLITE_DEFINES: &[&str] = &[
    "SQLITE_DEFAULT_MEMSTATUS=0",
    "SQLITE_DEFAULT_WAL_SYNCHRONOUS=1",
    "SQLITE_DQS=0",
    "SQLITE_LIKE_DOESNT_MATCH_BLOBS",
    "SQLITE_MAX_EXPR_DEPTH=0",
    "SQLITE_OMIT_AUTOINIT",
    "SQLITE_OMIT_DECLTYPE",
    "SQLITE_OMIT_DEPRECATED",
    "SQLITE_OMIT_LOAD_EXTENSION",
    "SQLITE_OMIT_SHARED_CACHE",
    "SQLITE_USE_ALLOCA",
    "SQLITE_ENABLE_BATCH_ATOMIC_WRITE",
    "SQLITE_ENABLE_BYTECODE_VTAB",
    "SQLITE_ENABLE_SESSION",
    "SQLITE_ENABLE_PREUPDATE_HOOK",
];

/// Native-only differences, each mirrored in the report of `scripts/check-sqlite-build.sh`.
const NATIVE_DEFINES: &[&str] = &[
    // wa-sqlite: THREADSAFE=0. rusqlite refuses single-threaded builds and connections move between tokio threads.
    "SQLITE_THREADSAFE=2",
    // wasm gets 0 implicitly from THREADSAFE=0; keep it so sorts stay single-threaded like wa-sqlite.
    "SQLITE_MAX_WORKER_THREADS=0",
    // Emscripten has no mmap so wasm reports MAX_MMAP_SIZE=0; pin it instead of the native default.
    "SQLITE_MAX_MMAP_SIZE=0",
];

fn main() {
    let dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let sqlite = dir.join("sqlite");
    let extension_functions = dir
        .join("../../../repos/livestore/packages/@livestore/wa-sqlite/src/extension-functions.c");
    for path in [&sqlite, &extension_functions, &dir.join("src/livestore.c")] {
        println!("cargo:rerun-if-changed={}", path.display());
    }

    let mut build = cc::Build::new();
    build
        .include(&sqlite)
        .file(dir.join("src/livestore.c"))
        .file(&extension_functions)
        .warnings(false);
    for define in WASQLITE_DEFINES.iter().chain(NATIVE_DEFINES) {
        build.flag(format!("-D{define}"));
    }
    build.compile("sqlite3");
    println!("cargo:include={}", sqlite.display());

    bindgen::builder()
        .default_macro_constant_type(bindgen::MacroTypeVariation::Signed)
        .disable_nested_struct_naming()
        .generate_cstr(true)
        .trust_clang_mangling(false)
        .header(sqlite.join("sqlite3.h").to_string_lossy())
        .clang_arg("-DSQLITE_ENABLE_SESSION")
        .clang_arg("-DSQLITE_ENABLE_PREUPDATE_HOOK")
        .parse_callbacks(Box::new(TypeChooser))
        .blocklist_function("sqlite3_auto_extension")
        .blocklist_function("sqlite3_cancel_auto_extension")
        .raw_line(AUTO_EXTENSION)
        .blocklist_function(".*16.*")
        .blocklist_function("sqlite3_close_v2")
        .blocklist_function("sqlite3_create_collation")
        .blocklist_function("sqlite3_create_function")
        .blocklist_function("sqlite3_create_module")
        .blocklist_function("sqlite3_prepare")
        .layout_tests(false)
        .generate()
        .expect("bindgen sqlite3.h")
        .write_to_file(PathBuf::from(env::var("OUT_DIR").unwrap()).join("bindgen.rs"))
        .unwrap();
}

/// Same int typing as upstream `libsqlite3-sys`, which rusqlite relies on.
#[derive(Debug)]
struct TypeChooser;

impl bindgen::callbacks::ParseCallbacks for TypeChooser {
    fn int_macro(&self, name: &str, _value: i64) -> Option<bindgen::callbacks::IntKind> {
        (name == "SQLITE_SERIALIZE_NOCOPY"
            || name.starts_with("SQLITE_DESERIALIZE_")
            || name.starts_with("SQLITE_PREPARE_")
            || name.starts_with("SQLITE_TRACE_"))
        .then_some(bindgen::callbacks::IntKind::UInt)
    }
}

const AUTO_EXTENSION: &str = r#"
type AutoExtension = ::std::option::Option<unsafe extern "C" fn(db: *mut sqlite3, pzErrMsg: *mut *mut ::std::os::raw::c_char, _: *const sqlite3_api_routines) -> ::std::os::raw::c_int>;
unsafe extern "C" {
    pub fn sqlite3_auto_extension(xEntryPoint: AutoExtension) -> ::std::os::raw::c_int;
    pub fn sqlite3_cancel_auto_extension(xEntryPoint: AutoExtension) -> ::std::os::raw::c_int;
}"#;
