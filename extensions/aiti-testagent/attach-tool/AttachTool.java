import com.sun.tools.attach.VirtualMachine;
public class AttachTool {
    public static void main(String[] a) throws Exception {
        if (a.length < 2) { System.out.println("usage: AttachTool <pid> <agentJar> [agentArgs]"); return; }
        String pid = a[0], jar = a[1], args = a.length > 2 ? a[2] : "";
        VirtualMachine vm = VirtualMachine.attach(pid);
        vm.loadAgent(jar, args);
        vm.detach();
        System.out.println("attached to " + pid + " args=" + args);
    }
}
