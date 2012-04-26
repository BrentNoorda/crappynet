#!/usr/bin/env python

"""
    Run jslint against a javascript file

    - This requires that mozilla's Rhino be installed, which for me simply required downloading
      rhino from http://www.mozilla.org/rhino/download.html, unzipping, and copying the
      js*.jar files to /Library/Java/Extensions/

"""

SPECIAL_JSLINT_IGNORE_STRING = 'ignore-this-jslint-error'

import os, sys, optparse, subprocess, time, signal

ignore_scripts = [
    os.path.normpath('/crappynet/tools/jslint.js'),
    os.path.normpath('/src/client/jquery-1.7.1.min.js'),
]

lintsalot_mode = False   # if called with lintsalot this runs all files and only prints errors

file_messages = ['FILE MESSAGES NOT INITIALIZED']      # save messages to be printed only when finished with file
def print_init(msg):
    global file_messages
    file_messages = []
    print_add(msg)
def print_add(msg):
    global lintsalot_mode
    global file_messages
    if lintsalot_mode:
        file_messages.append(msg)
    else:
        print msg
        sys.stdout.flush()
def print_term(success):
    global lintsalot_mode
    global file_messages
    if lintsalot_mode:
        if not success:
            for fm in file_messages:
                print fm
            sys.stdout.flush()
    file_messages = ['FILE MESSAGES NOT INITIALIZED']

def read_file_markers(sincefile):
    new_file_markers = { }
    fp = open(sincefile,'rt')
    alltext = fp.read()
    fp.close()
    for line in alltext.splitlines():
        markers = line.split(' <-linted-> ')
        new_file_markers[markers[1]] = markers[0]
    return new_file_markers
def write_file_markers(sincefile,new_file_markers):
    fp = open(sincefile,'wt')
    for k,v in new_file_markers.iteritems():
        fp.write( v + ' <-linted-> ' + k + '\n' )
    fp.close()


def runCommand(cmds,waitSecs=180.0):

    proc = subprocess.Popen(cmds, shell=False, stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    pid = proc.pid

    sleepInterval = 0.1
    waitALongTime = int( float(waitSecs) / sleepInterval )   # wait waitSecs seconds before giving up
    while True:

        waitALongTime -= 1
        if waitALongTime == 0:
            os.kill(pid,signal.SIGKILL)
            time.sleep(2)
            killedpid, stat = os.waitpid(pid, os.WNOHANG)
            if killedpid == 0:
                print "ACK. Process kill failed."
                sys.exit(1)
            else:
                print "killing process went OK, stat = " + str(stat)
                sys.exit(1)
            raise Exception, "kill process for running too long"

        retcode = proc.poll()
        if not retcode is None:
            break

        #print waitALongTime
        time.sleep(sleepInterval)

    results = proc.stdout.read()
    return results.split("\n")


my_dir = os.path.normpath(os.path.dirname(os.path.abspath(__file__)))

def run_cmd(cmd):
    print cmd
    os.system(cmd)

def get_all_jsfiles(allfiles,dir):
    for f in os.listdir(dir):
        fullspec = dir + os.sep + f
        if f.endswith('.js'):
            ignore_this_file = False
            for ignorance in ignore_scripts:
                if -1 != fullspec.find(ignorance):
                    ignore_this_file = True
            if not ignore_this_file:
                allfiles[fullspec] = True
        elif not os.path.isfile(fullspec):
            get_all_jsfiles(allfiles,fullspec)
    return allfiles

if __name__ == "__main__":

    try:
        parser = optparse.OptionParser()
        parser.add_option('-f', '--file',type='string')
        parser.add_option('--all',type='string')
        parser.add_option('--allnew',type='string')
        parser.add_option('--lintsalot',action='store_true')
        options, args = parser.parse_args()
        lintsalot_mode = True if options.lintsalot else False

        if options.file:
            jslint_js = my_dir + os.sep + 'jslint.js'
            ret = runCommand( [ 'java', '-jar', my_dir + os.sep + 'js.jar', my_dir + os.sep + 'jslint.js', options.file ] )
            no_problems = False

            for r in ret:
                if r.startswith('jslint: No problems found in '):
                    no_problems = True
                    break

            if not no_problems:
                # we'll actually ignore problems on lines that have /*ignore-this-jslint-error*/ in them
                # hopefully there won't be many of these
                problem_count = 0
                problem_description = None
                for r in ret:
                    if len(r) == 0:
                        continue
                    if problem_description is None:
                        problem_count += 1
                        if not r.startswith('Lint at line '):
                            print 'Line does not start with "Lint at line "'
                            break
                        problem_description = r
                    else:
                        if -1 != r.find(SPECIAL_JSLINT_IGNORE_STRING):
                            # some dang quitter gave up on satisfying jslint
                            problem_count -= 1
                        problem_description = None
                if problem_count == 0:
                    no_problems = True

            if no_problems:
                print "JSLINT NO PROBLEM WITH " + options.file
                sys.stdout.flush()
                sys.exit(0)
            print
            print "JSLINT START PROBLEMS WITH " + options.file
            for r in ret:
                print ' ' + r
                sys.stdout.flush()
            print "JSLINT END PROBLEMS WITH " + options.file
            print
            sys.stdout.flush()

        elif options.all or options.allnew:
            js_dir = os.path.normpath(my_dir + '/..')
            if options.allnew:
                sincefile = options.allnew
                try:
                    old_file_markers = read_file_markers(sincefile)
                except:
                    # no since file, so start all over from scratch
                    old_file_markers = { }  # initialize to being empty
            else:
                sincefile = options.all
                old_file_markers = { }  # initialize to being empty
            new_file_markers = { }
            allfiles = get_all_jsfiles({},js_dir)
            all_perfect = True
            for f in allfiles:
                new_file_time = str(os.path.getmtime(f))
                try:
                    old_file_time = old_file_markers[f]
                except:
                    old_file_time = 'xxx'
                if old_file_time == new_file_time:
                    # no change, so do not relint
                    new_file_markers[f] = new_file_time
                else:
                    no_problem = False
                    print_init("Run lint against " + f)
                    ret = runCommand( [ 'python', my_dir+os.sep+'jslint.py', '--file', f ] )
                    for r in ret:
                        print_add(' ' + r)
                        if r.startswith("JSLINT NO PROBLEM WITH "):
                            no_problem = True
                    if no_problem:
                        print_term(True)
                        new_file_markers[f] = new_file_time
                    else:
                        print_term(False)
                        all_perfect = False
                        if not lintsalot_mode:
                            break
            if not lintsalot_mode:
                print
                sys.stdout.flush()
            write_file_markers(sincefile,new_file_markers)
            if all_perfect:
                print "ALL FILES ARE OKEEDOKEE"
                sys.stdout.flush()
                sys.exit(0)

        else:
            print "jslint.py has two uses"
            print "  python jslint.py --file <js_filespec>"
            print "  python jselint.py --all <temp-marker-file>"
            print "  python jselint.py --allnew <temp-marker-file>"
            print "  EXAMPLE: python jslint.py --allnew ~/.Trash/jslint_crappynet.allnew_marker"
            sys.exit(1)

        #cmd = 'java org.mozilla.javascript.tools.shell.Main ' + jslint_js + ' ' + sys.argv[1]
        #run_cmd(cmd)

    except Exception, err:
        print "Exception " + str(err)
        pass

    sys.exit(1)
