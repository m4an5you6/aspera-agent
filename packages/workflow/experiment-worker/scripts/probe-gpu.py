"""Open a CUDA context and allocate a few bytes through the driver API."""
import ctypes

cuda = ctypes.CDLL("libcuda.so.1")


def call(name, *args):
    result = getattr(cuda, name)(*args)
    if result != 0:
        raise RuntimeError(f"{name} returned CUDA error {result}")


call("cuInit", 0)
count = ctypes.c_int()
call("cuDeviceGetCount", ctypes.byref(count))
if count.value < 1:
    raise RuntimeError("no CUDA device is visible")
device = ctypes.c_int()
call("cuDeviceGet", ctypes.byref(device), 0)
context = ctypes.c_void_p()
call("cuCtxCreate_v2", ctypes.byref(context), 0, device)
allocation = ctypes.c_uint64()
try:
    call("cuMemAlloc_v2", ctypes.byref(allocation), 4096)
    call("cuMemFree_v2", allocation)
finally:
    call("cuCtxDestroy_v2", context)
print(f"cuda devices={count.value}; context and allocation passed")
