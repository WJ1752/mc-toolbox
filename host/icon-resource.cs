// Build-only helper: replace Node's icon resources without changing other PE resources.
// Run before SEA injection, then verify the final executable after injection.
using System;
using System.IO;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

class IconResource {
    delegate bool NameCallback(IntPtr module, IntPtr type, IntPtr name, IntPtr param);
    delegate bool LangCallback(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr param);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryEx(string file, IntPtr handle, uint flags);
    [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool EnumResourceNames(IntPtr module, IntPtr type, NameCallback callback, IntPtr param);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool EnumResourceLanguages(IntPtr module, IntPtr type, IntPtr name, LangCallback callback, IntPtr param);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr BeginUpdateResource(string file, bool deleteExisting);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool EndUpdateResource(IntPtr update, bool discard);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr FindResourceEx(IntPtr module, IntPtr type, IntPtr name, ushort language);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll")] static extern IntPtr LockResource(IntPtr resource);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint SizeofResource(IntPtr module, IntPtr resource);

    class Entry {
        public ushort Type, Language;
        public long Id;
        public string Name;
        public IntPtr Pin() { return Name == null ? new IntPtr(Id) : Marshal.StringToHGlobalUni(Name); }
        public void Unpin(IntPtr value) { if (Name != null) Marshal.FreeHGlobal(value); }
    }
    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static IntPtr Open(string file) {
        IntPtr module = LoadLibraryEx(Path.GetFullPath(file), IntPtr.Zero, 2 | 32);
        if (module == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        return module;
    }
    static List<Entry> Entries(IntPtr module) {
        var result = new List<Entry>();
        foreach (ushort type in new ushort[] {3, 14}) {
            bool success = EnumResourceNames(module, new IntPtr(type), delegate(IntPtr m, IntPtr t, IntPtr n, IntPtr p) {
                return EnumResourceLanguages(m, t, n, delegate(IntPtr mm, IntPtr tt, IntPtr nn, ushort lang, IntPtr pp) {
                    long id = nn.ToInt64();
                    result.Add(new Entry {Type=type, Language=lang, Id=id, Name=(id > 65535 || id < 0) ? Marshal.PtrToStringUni(nn) : null});
                    return true;
                }, IntPtr.Zero);
            }, IntPtr.Zero);
            if (!success && Marshal.GetLastWin32Error() != 1813) Check(false);
        }
        return result;
    }
    static byte[] Read(IntPtr module, ushort type, ushort id) {
        IntPtr resource = FindResourceEx(module, new IntPtr(type), new IntPtr(id), 1033);
        if (resource == IntPtr.Zero) throw new Exception("Missing icon resource: " + type + "/" + id);
        byte[] bytes = new byte[SizeofResource(module, resource)];
        IntPtr data = LockResource(LoadResource(module, resource));
        if (data == IntPtr.Zero) throw new Exception("Cannot load icon resource");
        Marshal.Copy(data, bytes, 0, bytes.Length);
        return bytes;
    }
    static void Equal(byte[] expected, byte[] actual) {
        if (expected.Length != actual.Length) throw new Exception("Icon resource size mismatch");
        for (int i=0; i<expected.Length; i++) if (expected[i] != actual[i]) throw new Exception("Icon resource bytes mismatch");
    }
    static int Main(string[] args) {
        try {
            if (args.Length < 2) throw new Exception("Usage: icon-resource.exe target.exe app.ico [--verify]");
            byte[] ico = File.ReadAllBytes(args[1]);
            if (ico.Length < 6 || BitConverter.ToUInt16(ico,0) != 0 || BitConverter.ToUInt16(ico,2) != 1) throw new Exception("Invalid ICO header");
            int count = BitConverter.ToUInt16(ico,4);
            if (count < 1 || count > 32 || ico.Length < 6 + count*16) throw new Exception("Invalid ICO directory");
            byte[] group = new byte[6+count*14];
            Array.Copy(ico,group,6);
            var images = new List<byte[]>();
            for (int i=0;i<count;i++) {
                int pos=6+i*16, len=checked((int)BitConverter.ToUInt32(ico,pos+8)), offset=checked((int)BitConverter.ToUInt32(ico,pos+12));
                if (len < 1 || offset < 6+count*16 || offset > ico.Length-len) throw new Exception("Invalid ICO image bounds");
                byte[] image = new byte[len]; Array.Copy(ico,offset,image,0,len); images.Add(image);
                Array.Copy(ico,pos,group,6+i*14,12);
                Array.Copy(BitConverter.GetBytes((ushort)(i+1)),0,group,6+i*14+12,2);
            }
            if (args.Length < 3 || args[2] != "--verify") {
                IntPtr module=Open(args[0]); List<Entry> old;
                try { old=Entries(module); } finally { FreeLibrary(module); }
                IntPtr update=BeginUpdateResource(args[0],false);
                if (update == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                try {
                    foreach (Entry entry in old) {
                        IntPtr name=entry.Pin();
                        try { Check(UpdateResource(update,new IntPtr(entry.Type),name,entry.Language,null,0)); }
                        finally { entry.Unpin(name); }
                    }
                    for (int i=0;i<count;i++) Check(UpdateResource(update,new IntPtr(3),new IntPtr(i+1),1033,images[i],(uint)images[i].Length));
                    Check(UpdateResource(update,new IntPtr(14),new IntPtr(1),1033,group,(uint)group.Length));
                    Check(EndUpdateResource(update,false)); update=IntPtr.Zero;
                } finally { if (update != IntPtr.Zero) EndUpdateResource(update,true); }
            }
            IntPtr verify=Open(args[0]);
            try {
                if (Entries(verify).Count != count+1) throw new Exception("Unexpected leftover icon resources");
                Equal(group,Read(verify,14,1));
                for (int i=0;i<count;i++) Equal(images[i],Read(verify,3,(ushort)(i+1)));
            } finally { FreeLibrary(verify); }
            Console.WriteLine("Application icon verified: " + count + " sizes; no Node icon group remains.");
            return 0;
        } catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
    }
}
