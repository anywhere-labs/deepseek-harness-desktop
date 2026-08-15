// ABI probe: prints sizeof/offsetof/enum values from the actual MinGW Windows
// headers on this machine. These numbers are the source of truth for the
// koffi FFI definitions in the Node.js port.
#include <Windows.h>
#include <sddl.h>
#include <AclAPI.h>
#include <cstdio>
#include <cstddef>

#define P(expr) printf("%-52s = %llu\n", #expr, (unsigned long long)(expr))

int wmain()
{
	P(sizeof(void*));
	P(sizeof(HANDLE));
	P(sizeof(DWORD));
	P(sizeof(WORD));
	P(sizeof(BOOL));

	P(sizeof(STARTUPINFOW));
	P(offsetof(STARTUPINFOW, cb));
	P(offsetof(STARTUPINFOW, lpReserved));
	P(offsetof(STARTUPINFOW, lpDesktop));
	P(offsetof(STARTUPINFOW, lpTitle));
	P(offsetof(STARTUPINFOW, dwX));
	P(offsetof(STARTUPINFOW, dwY));
	P(offsetof(STARTUPINFOW, dwXSize));
	P(offsetof(STARTUPINFOW, dwYSize));
	P(offsetof(STARTUPINFOW, dwXCountChars));
	P(offsetof(STARTUPINFOW, dwYCountChars));
	P(offsetof(STARTUPINFOW, dwFillAttribute));
	P(offsetof(STARTUPINFOW, dwFlags));
	P(offsetof(STARTUPINFOW, wShowWindow));
	P(offsetof(STARTUPINFOW, cbReserved2));
	P(offsetof(STARTUPINFOW, lpReserved2));
	P(offsetof(STARTUPINFOW, hStdInput));
	P(offsetof(STARTUPINFOW, hStdOutput));
	P(offsetof(STARTUPINFOW, hStdError));

	P(sizeof(PROCESS_INFORMATION));
	P(offsetof(PROCESS_INFORMATION, hProcess));
	P(offsetof(PROCESS_INFORMATION, hThread));
	P(offsetof(PROCESS_INFORMATION, dwProcessId));
	P(offsetof(PROCESS_INFORMATION, dwThreadId));

	P(sizeof(SECURITY_ATTRIBUTES));
	P(offsetof(SECURITY_ATTRIBUTES, nLength));
	P(offsetof(SECURITY_ATTRIBUTES, lpSecurityDescriptor));
	P(offsetof(SECURITY_ATTRIBUTES, bInheritHandle));

	P(sizeof(TRUSTEE_W));
	P(offsetof(TRUSTEE_W, pMultipleTrustee));
	P(offsetof(TRUSTEE_W, MultipleTrusteeOperation));
	P(offsetof(TRUSTEE_W, TrusteeForm));
	P(offsetof(TRUSTEE_W, TrusteeType));
	P(offsetof(TRUSTEE_W, ptstrName));

	P(sizeof(EXPLICIT_ACCESS_W));
	P(offsetof(EXPLICIT_ACCESS_W, grfAccessPermissions));
	P(offsetof(EXPLICIT_ACCESS_W, grfAccessMode));
	P(offsetof(EXPLICIT_ACCESS_W, grfInheritance));
	P(offsetof(EXPLICIT_ACCESS_W, Trustee));

	P(sizeof(SID_AND_ATTRIBUTES));
	P(offsetof(SID_AND_ATTRIBUTES, Sid));
	P(offsetof(SID_AND_ATTRIBUTES, Attributes));

	P(sizeof(TOKEN_GROUPS));
	P(offsetof(TOKEN_GROUPS, GroupCount));
	P(offsetof(TOKEN_GROUPS, Groups));

	P(sizeof(TOKEN_MANDATORY_LABEL));

	P(sizeof(SID));
	P(SECURITY_MAX_SID_SIZE);
	P(SID_MAX_SUB_AUTHORITIES);
	P(SID_REVISION);

	P(TOKEN_ASSIGN_PRIMARY);
	P(TOKEN_DUPLICATE);
	P(TOKEN_QUERY);
	P(TOKEN_ADJUST_DEFAULT);

	P(SE_GROUP_LOGON_ID);
	P(SE_GROUP_INTEGRITY);
	P(SE_GROUP_INTEGRITY_ENABLED);

	P(FILE_GENERIC_WRITE);
	P((FILE_GENERIC_WRITE & ~STANDARD_RIGHTS_WRITE));
	P(STANDARD_RIGHTS_WRITE);
	P(DELETE);
	P(FILE_DELETE_CHILD);
	P(((FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD) & ~STANDARD_RIGHTS_WRITE));

	P(FILE_SHARE_READ);
	P(FILE_SHARE_WRITE);
	P(FILE_SHARE_DELETE);
	P(GENERIC_READ);
	P(GENERIC_WRITE);
	P(OPEN_ALWAYS);
	P(LOCKFILE_EXCLUSIVE_LOCK);
	P(LOCKFILE_FAIL_IMMEDIATELY);
	P(ERROR_LOCK_VIOLATION);
	P(INHERITED_ACE);

	P(DISABLE_MAX_PRIVILEGE);
	P(SANDBOX_INERT);
	P(LUA_TOKEN);
	P(WRITE_RESTRICTED);

	P((int)WinWorldSid);
	P((int)WinLocalLogonSid);
	P((int)WinConsoleLogonSid);

	P((int)TokenUser);
	P((int)TokenGroups);
	P((int)TokenIntegrityLevel);

	P((int)SE_FILE_OBJECT);
	P(DACL_SECURITY_INFORMATION);

	P((int)TRUSTEE_IS_UNKNOWN);
	P((int)TRUSTEE_IS_SID);
	P((int)NOT_USED_ACCESS);
	P((int)GRANT_ACCESS);
	P((int)REVOKE_ACCESS);
	P(SUB_CONTAINERS_AND_OBJECTS_INHERIT);
	P(OBJECT_INHERIT_ACE);
	P(CONTAINER_INHERIT_ACE);

	P(CREATE_SUSPENDED);
	P(CREATE_NO_WINDOW);
	P(DETACHED_PROCESS);
	P(CREATE_NEW_CONSOLE);
	P(STARTF_USESTDHANDLES);
	P(STARTF_USESHOWWINDOW);
	P(SW_HIDE);
	P(HANDLE_FLAG_INHERIT);
	P(INFINITE);

	P(LMEM_FIXED);
	P(LMEM_ZEROINIT);
	P(LPTR);

	P(FORMAT_MESSAGE_ALLOCATE_BUFFER);
	P(FORMAT_MESSAGE_FROM_SYSTEM);
	P(FORMAT_MESSAGE_IGNORE_INSERTS);
	P(MAX_PATH);

	P(ERROR_SUCCESS);
	P(ERROR_INSUFFICIENT_BUFFER);
	P(ERROR_NO_MORE_ITEMS);
	P(ERROR_INVALID_PARAMETER);
	P(ERROR_INVALID_SID);
	P(ERROR_NONE_MAPPED);
	P(ERROR_BROKEN_PIPE);

	// Job object (runner kill-on-close hardening)
	P(sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
	P(sizeof(JOBOBJECT_BASIC_LIMIT_INFORMATION));
	P(sizeof(IO_COUNTERS));
	P(offsetof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION, BasicLimitInformation));
	P(offsetof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION, BasicLimitInformation) + offsetof(JOBOBJECT_BASIC_LIMIT_INFORMATION, LimitFlags));
	P(offsetof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION, ProcessMemoryLimit));
	P((int)JobObjectExtendedLimitInformation);
	P(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);

	// static assertions for the values the koffi module will hardcode
	static_assert(sizeof(STARTUPINFOW) == 104, "STARTUPINFOW size");
	static_assert(sizeof(PROCESS_INFORMATION) == 24, "PROCESS_INFORMATION size");
	static_assert(sizeof(SECURITY_ATTRIBUTES) == 24, "SECURITY_ATTRIBUTES size");
	static_assert(sizeof(EXPLICIT_ACCESS_W) == 48, "EXPLICIT_ACCESS_W size");
	static_assert(sizeof(TRUSTEE_W) == 32, "TRUSTEE_W size");
	static_assert(sizeof(SID_AND_ATTRIBUTES) == 16, "SID_AND_ATTRIBUTES size");
	static_assert(SECURITY_MAX_SID_SIZE == 68, "SECURITY_MAX_SID_SIZE");
	static_assert(TOKEN_QUERY == 0x8 && TOKEN_DUPLICATE == 0x2 && TOKEN_ADJUST_DEFAULT == 0x80 && TOKEN_ASSIGN_PRIMARY == 0x1, "token rights");
	static_assert(SE_GROUP_LOGON_ID == 0xC0000000, "logon id attr");
	static_assert(FILE_GENERIC_WRITE == 0x120116, "generic write");
	static_assert((FILE_GENERIC_WRITE & ~STANDARD_RIGHTS_WRITE) == 0x100116, "poc grant mask");
	static_assert(DELETE == 0x10000 && FILE_DELETE_CHILD == 0x40, "delete rights");
	static_assert(((FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD) & ~STANDARD_RIGHTS_WRITE) == 0x110156, "sandbox grant mask");
	static_assert(FILE_SHARE_READ == 0x1 && FILE_SHARE_WRITE == 0x2 && FILE_SHARE_DELETE == 0x4, "share modes");
	static_assert(OPEN_ALWAYS == 4, "open always");
	static_assert(LOCKFILE_EXCLUSIVE_LOCK == 0x2 && LOCKFILE_FAIL_IMMEDIATELY == 0x1, "lockfile flags");
	static_assert(ERROR_LOCK_VIOLATION == 33, "lock violation");
	static_assert(INHERITED_ACE == 0x10, "inherited ace flag");
	static_assert(GRANT_ACCESS == 1 && REVOKE_ACCESS == 4, "access modes");
	static_assert(SUB_CONTAINERS_AND_OBJECTS_INHERIT == 0x3, "inheritance");
	static_assert(CREATE_NO_WINDOW == 0x08000000, "create no window");
	static_assert(STARTF_USESTDHANDLES == 0x100, "std handles flag");
	static_assert(STARTF_USESHOWWINDOW == 0x1 && SW_HIDE == 0, "hidden startup window");
	static_assert(sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) == 144, "job extended limit size");
	static_assert(offsetof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION, BasicLimitInformation) + offsetof(JOBOBJECT_BASIC_LIMIT_INFORMATION, LimitFlags) == 16, "job LimitFlags offset");
	static_assert(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE == 0x2000, "kill on job close flag");
	static_assert(JobObjectExtendedLimitInformation == 9, "extended limit class");
	printf("\nstatic_asserts passed\n");
	return 0;
}
