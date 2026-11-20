/* One translation unit so the startup hook is always linked with the library. */
#include "sqlite3.c"

int RegisterExtensionFunctions(sqlite3 *db);

static int register_extension_functions(sqlite3 *db, char **err, const void *api) {
  return RegisterExtensionFunctions(db);
}

/* wa-sqlite's main() calls sqlite3_initialize() (needed with SQLITE_OMIT_AUTOINIT) and its open_v2
   registers extension-functions.c on every connection. */
__attribute__((constructor)) static void livestore_sqlite_init(void) {
  sqlite3_initialize();
  sqlite3_auto_extension((void (*)(void))register_extension_functions);
}
